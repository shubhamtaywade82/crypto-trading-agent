import type { BriefTimeframeRead, BriefZone, MarketBrief, BriefSnapshotComparison, BriefTakerBucket } from './types.js';
import { BRIEF_TIMEFRAMES } from './types.js';
import { fmtPrice, fmtPct, fmtRatePct, fmtQty, fmtUsdCompact, fmtUtcHm, fmtUtcHmz, fmtUtcStamp } from './format.js';

/**
 * Renders a MarketBrief as markdown in the shape of the operator's live market brief: numbered
 * sections, tables of readings, explicit no-trade conditions, and a bottom line. The renderer is
 * presentation only — every conclusion and number comes from the builder, and a missing reading
 * always renders as "—" rather than being dropped or invented.
 */

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

const usd = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `$${fmtPrice(p)}`);
/** Mark and index prices carry an extra decimal on Binance (mark tick vs trade tick). */
const usdMark = (p: number | null | undefined) =>
  p === null || p === undefined ? '—' : `$${Math.abs(p) >= 1 ? p.toFixed(4) : p.toFixed(6)}`;

const zoneRef = (z: BriefZone) => `$${fmtPrice(z.low)}${z.high !== z.low ? `–$${fmtPrice(z.high)}` : ''}`;

const ZONE_ROLE_TEXT: Record<BriefZone['role'], string> = {
  IMMEDIATE_SUPPORT: 'Immediate support',
  NEXT_SUPPORT: 'Next support',
  LOWER_SUPPORT: 'Lower support zone',
  MAJOR_REFERENCE: 'Major reference',
  RECLAIM_ZONE: 'Reclaim zone',
  NEAR_TERM_RESISTANCE: 'Major near-term resistance',
  HIGHER_RESISTANCE: 'Higher resistance',
};

function priceSection(brief: MarketBrief): string {
  const p = brief.price;
  const change = p.changePct24h !== null && p.changeAbs24h !== null
    ? `${fmtPct(p.changePct24h)} (${p.changeAbs24h >= 0 ? '+' : ''}$${fmtPrice(p.changeAbs24h)})`
    : fmtPct(p.changePct24h);
  const volume = p.volumeBase24h !== null && p.volumeQuote24h !== null
    ? `${fmtQty(p.volumeBase24h)} SOL`
    : p.volumeBase24h !== null ? `${fmtQty(p.volumeBase24h)}` : '—';

  const rows = [
    ['Last traded price', usd(p.lastPrice)],
    ['24h change', change],
    ['24h high', usd(p.high24h)],
    ['24h low', usd(p.low24h)],
    ['24h volume', volume],
    ['24h quote volume', p.volumeQuote24h !== null ? `~$${fmtQty(p.volumeQuote24h)} USDT` : '—'],
    ['Mark price', usdMark(p.markPrice)],
    ['Index price', usdMark(p.indexPrice)],
    ['Best bid / ask in latest depth snapshot', `${usd(p.bestBid)} / ${usd(p.bestAsk)}`],
  ];

  return [
    '## 1. Price and 24-hour statistics',
    '',
    table(['Metric', 'Latest reading'], rows),
    '',
    ...(p.lastPrice !== null && p.high24h !== null && p.low24h !== null
      ? [`${brief.symbol.replace(/USDT$/, '')} is ${fmtPct(((p.lastPrice - p.high24h) / p.high24h) * 100)} below its 24-hour high and trading in the ${p.high24h !== p.low24h ? (((p.lastPrice - p.low24h) / (p.high24h - p.low24h)) * 100).toFixed(0) : '—'}% portion of its 24-hour range. That is context for the broader move, not a signal that the latest pullback has ended.`]
      : []),
    '',
  ].join('\n');
}

function timeframeSection(brief: MarketBrief): string {
  const rows = BRIEF_TIMEFRAMES.map((tf) => {
    const read: BriefTimeframeRead = brief.timeframes[tf];
    const confirmed = read.confirmedCloseTime !== null ? `${fmtUtcHm(read.confirmedCloseTime)} close: $${fmtPrice(read.confirmed?.close ?? null)}` : '—';
    const structure = `${read.confirmedNarrative} ${read.formingNarrative}`;
    return [tf, confirmed, structure];
  });

  return [
    '## 2. Multi-timeframe structure',
    '',
    'Important: Confirmed candles below are closed candles. Current candles remain open and must not be treated as confirmed signals.',
    '',
    table(['Timeframe', 'Latest confirmed candle, UTC', 'Current structure'], rows),
    '',
    'Interpretation: the higher-timeframe reads stand on confirmed closes only. A bullish 1h/4h structure does not, by itself, justify buying during a 5m/15m selloff, and a forming candle breaking a level is not a confirmed break.',
    '',
  ].join('\n');
}

function takerRow(bucket: BriefTakerBucket): string {
  const ratio = bucket.ratio !== null ? bucket.ratio.toFixed(4) : '—';
  const volumes = bucket.buyVol !== null && bucket.sellVol !== null
    ? `buys: ${fmtQty(bucket.buyVol)}; sells: ${fmtQty(bucket.sellVol)}`
    : 'volumes not reported';
  const bucketTime = bucket.bucketTime !== null ? ` (bucket ending ${fmtUtcHm(bucket.bucketTime)} UTC)` : '';
  return `${ratio} — ${volumes}${bucketTime}`;
}

function derivativesSection(brief: MarketBrief): string {
  const d = brief.positioning;
  const oiTrend = d.oiTrend.from !== null && d.oiTrend.to !== null
    ? `${fmtQty(d.oiTrend.from)} at ${fmtUtcHm(d.oiTrend.fromTime)} → ${fmtQty(d.oiTrend.to)} at ${fmtUtcHm(d.oiTrend.toTime)} (${fmtPct(d.oiTrend.changePct, 2)})`
    : '—';
  const globalRatio = d.globalLongShortRatio !== null
    ? `${d.globalLongShortRatio.toFixed(2)} : 1 (${d.globalLongPct?.toFixed(2) ?? '—'}% long accounts vs ${d.globalShortPct?.toFixed(2) ?? '—'}% short)`
    : '—';

  const rows = [
    ['Funding rate', d.fundingRate !== null ? `${fmtRatePct(d.fundingRate)} (${d.fundingRate >= 0 ? 'longs pay shorts' : 'shorts pay longs'} at settlement${d.fundingAprPct !== null ? `; ~${d.fundingAprPct.toFixed(2)}% APR` : ''})` : '—'],
    ['Next funding time', fmtUtcHmz(d.nextFundingTime)],
    ['Open interest', d.openInterest !== null ? `~${fmtQty(d.openInterest)} ${brief.symbol.replace(/USDT$/, '')}` : '—'],
    ['Open interest notional', d.openInterestNotionalUsd !== null ? `~${fmtUsdCompact(d.openInterestNotionalUsd)} at the current price (approximation)` : '—'],
    ['OI trend (hourly snapshots)', oiTrend],
    ['Global account long/short ratio', globalRatio],
    ['Top-trader position long/short ratio', d.topTraderPositionLongShortRatio !== null ? d.topTraderPositionLongShortRatio.toFixed(2) + ' : 1' : 'not available in the retrieved data'],
    ['Latest 5m taker flow', takerRow(d.taker['5m'])],
    ['Latest 15m taker flow', takerRow(d.taker['15m'])],
    ['Latest 1h taker flow', takerRow(d.taker['1h'])],
  ];

  const shortFlow = d.taker['5m'].dominance === 'SELL' && d.taker['15m'].dominance === 'SELL';
  const hourlyBuy = d.taker['1h'].dominance === 'BUY';
  const oiFalling = d.oiTrend.changePct !== null && d.oiTrend.changePct < 0;
  const longCrowded = d.globalLongShortRatio !== null && d.globalLongShortRatio >= 2;

  const bullets = [
    shortFlow
      ? `- Short-term flow is bearish: the latest 5m and 15m buckets both show more aggressive selling.`
      : `- Short-term flow is ${d.taker['5m'].dominance === 'BUY' ? 'buy-dominant' : 'not clearly directional'} on the latest buckets.`,
    hourlyBuy
      ? '- Hourly flow is more constructive: the latest published 1h bucket had more taker buying than selling.'
      : '- The latest published 1h bucket is not buy-dominant.',
    oiFalling
      ? '- Open interest is falling: this does not confirm fresh long buildup behind the latest move. It could reflect position reduction or short covering; these data alone cannot distinguish the two.'
      : '- Open interest is not falling across the reported window.',
    longCrowded
      ? `- Positioning remains long-heavy: with roughly ${d.globalLongShortRatio!.toFixed(1)} long accounts per short account, another price decline could pressure longs. This is a risk observation, not proof of a coming liquidation event.`
      : '- Positioning is not long-crowded on the reported account ratio.',
    '- The published taker buckets for different periods do not necessarily end at the same time; each row above carries its own bucket timestamp.',
  ];

  return [
    '## 3. Derivatives, positioning and order flow',
    '',
    table(['Metric', 'Latest available reading'], rows),
    '',
    'What matters here',
    '',
    ...bullets,
    '',
  ].join('\n');
}

function zonesSection(brief: MarketBrief): string {
  const rows = brief.zones.map((z) => [zoneRef(z), ZONE_ROLE_TEXT[z.role], z.why]);
  const largestBid = brief.book.largestBidLevel;
  const largestAsk = brief.book.largestAskLevel;

  return [
    '## 4. Key support and resistance',
    '',
    'These are observed price zones derived from recent candles and the 24-hour range — not guaranteed turning points.',
    '',
    ...(rows.length > 0 ? [table(['Zone', 'Role', 'Why it matters'], rows), ''] : ['No complete zone map could be derived from the confirmed candles.', '']),
    ...(largestBid || largestAsk
      ? [`The latest order-book snapshot also showed displayed bid liquidity near ${largestBid ? `$${fmtPrice(largestBid.price)}` : '—'} and ask liquidity near ${largestAsk ? `$${fmtPrice(largestAsk.price)}` : '—'}. These are transient book concentrations, not validated support or resistance; orders can be modified or withdrawn.`, '']
      : []),
  ].join('\n');
}

function scenarioSection(brief: MarketBrief): string {
  const { bullish, bearish } = brief.scenarios;
  const nextRefs = (zones: BriefZone[]) =>
    zones.length > 0
      ? `The next references would be ${zones.slice(0, 2).map(zoneRef).join(', ')}${zones.length > 2 ? ', followed by ' + zoneRef(zones[2]!) : ''}.`
      : 'No further mapped zones lie beyond that level.';

  return [
    '## 5. Conditional scenarios',
    '',
    'Bullish scenario — recovery must be confirmed',
    '',
    ...bullish.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    nextRefs(bullish.nextReferences),
    '',
    `Invalidation: ${bullish.invalidation}`,
    '',
    'Bearish scenario — support must break',
    '',
    ...bearish.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    nextRefs(bearish.nextReferences),
    '',
    `Invalidation: ${bearish.invalidation}`,
    '',
    'A drop below support on a still-forming candle is not sufficient confirmation, and neither is a single wick above resistance.',
    '',
  ].join('\n');
}

function noTradeSection(brief: MarketBrief): string {
  const { low, high } = brief.noEntryZone;
  const band = low !== null && high !== null
    ? `Remain flat for a new entry while price is between the $${fmtPrice(low)} support area and the $${fmtPrice(high)} reclaim zone without a confirmed breakout or breakdown.`
    : 'The zone map is incomplete on at least one side, so no entry can be conditioned on a mapped confirmation level. Remain flat.';

  const conditions = [
    ...(brief.noTradeReasons.length > 0 ? brief.noTradeReasons.map((reason) => `- ${reason};`) : []),
    '- price breaks a level but immediately reclaims it;',
    '- market data become stale or inconsistent.',
  ];

  return [
    `## 6. Explicit ${brief.decision === 'NO_TRADE' ? 'NO-TRADE' : 'confirmation'} condition`,
    '',
    band,
    '',
    'Continue to stand aside if:',
    '',
    ...conditions,
    '',
    'No probability is assigned to any scenario because the available evidence does not establish a calibrated probability of success.',
    '',
  ].join('\n');
}

function historySection(brief: MarketBrief): string {
  if (brief.history.length === 0) {
    return [
      '## 7. Change versus recent recorded context',
      '',
      'No recorded snapshots were found for this symbol, so no day-over-day comparison can be made. This section reports recorded history only; it never substitutes an estimate.',
      '',
    ].join('\n');
  }

  const lines = brief.history.map((h: BriefSnapshotComparison) => {
    const parts = [
      `- ${h.date}: the last recorded snapshot closed at a recorded mark of ${usdMark(h.recordedMark)}. The current price is ${fmtPct(h.currentVsRecordedPct, 2)} against that point-in-time reading — a comparison between two snapshots, not a continuous-period return.`,
    ];
    if (h.oiChangePct !== null) parts.push(`  Recorded open interest ${h.recordedOpenInterest !== null ? fmtQty(h.recordedOpenInterest) : '—'} vs current: ${fmtPct(h.oiChangePct, 2)}.`);
    if (h.recordedFunding === null && h.recordedTakerRatio === null) parts.push('  That snapshot did not contain a verified synchronized funding and taker-flow baseline, so those changes are not quantified.');
    return parts.join('\n');
  });

  return [
    '## 7. Change versus recent recorded context',
    '',
    ...lines,
    '',
  ].join('\n');
}

/** Full markdown brief: title, executive decision, sections 1–7, bottom line. */
export function renderBriefMarkdown(brief: MarketBrief): string {
  const dataNote = brief.dataErrors.length > 0
    ? [`Data availability: ${brief.dataErrors.length} endpoint(s) failed or returned nothing (${brief.dataErrors.map((e) => e.split(':')[0]).join(', ')}). Affected readings show "—"; no value was substituted.`, '']
    : [];

  return [
    `# ${brief.symbol} USDⓈ-M Futures — Live Market Brief`,
    '',
    `Snapshot: ${fmtUtcStamp(brief.generatedAt)}, from live Binance market-data endpoints.`,
    '',
    ...dataNote,
    `Executive decision: ${brief.decisionHeadline}`,
    '',
    ...brief.summary.map((p) => p + '\n'),
    priceSection(brief),
    timeframeSection(brief),
    derivativesSection(brief),
    zonesSection(brief),
    scenarioSection(brief),
    noTradeSection(brief),
    historySection(brief),
    '## Bottom line',
    '',
    brief.bottomLine,
    '',
  ].join('\n');
}
