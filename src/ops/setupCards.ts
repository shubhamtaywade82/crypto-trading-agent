import { formatPrice } from '../binance/symbolRules.js';
import { escapeHtml } from './telegram.js';
import type { SetupMap, SetupScenario } from '../decision/SetupEngine.js';
import { formatDuration, formatMinutes } from '../decision/SetupTiming.js';

const MAX_CARD_CHARS = 3_500;

const clean = (value: string): string =>
  escapeHtml(value.replace(/\s+/g, ' ').trim());

const percent = (value: number): string => `${value.toFixed(0)}%`;



const statusLabel = (scenario: SetupScenario): string =>
  scenario.state === 'TRIGGERED' ? '🟢 TRIGGERED' : '🟡 WATCHING';

const setupLabel = (kind: SetupScenario['kind']): string => {
  if (kind === 'LIQUIDITY_SWEEP') return 'LIQUIDITY SWEEP';
  if (kind === 'PULLBACK_RETEST') return 'PULLBACK / RETEST';
  return 'BREAKOUT / RETEST';
};

function scenarioLines(symbol: string, setup: SetupScenario): string[] {
  const entry = setup.entryLow === setup.entryHigh
    ? formatPrice(symbol, setup.entryLow)
    : `${formatPrice(symbol, setup.entryLow)}–${formatPrice(symbol, setup.entryHigh)}`;
  const target2 = setup.target2 !== undefined ? ` · <b>TP2:</b> ${formatPrice(symbol, setup.target2)}` : '';
  return [
    `<b>${statusLabel(setup)} · ${setup.direction} · ${setupLabel(setup.kind)}</b>`,
    `🎯 <b>Entry:</b> ${entry}`,
    `🛑 <b>SL:</b> ${formatPrice(symbol, setup.stopLoss)}`,
    `✅ <b>TP1:</b> ${formatPrice(symbol, setup.target1)}${target2}`,
    `⚖️ <b>RR:</b> ${setup.rewardRisk.toFixed(2)} · <b>Target move:</b> ${setup.expectedMove.distanceAtr.toFixed(2)} ATR`,
    `⚡ <b>Trigger:</b> ${clean(setup.trigger)}`,
    `⛔ <b>Invalidation:</b> ${clean(setup.invalidation)}`,
    `🧠 <b>Flow hypothesis:</b> ${clean(setup.flowHypothesis)}`,
    `⏱️ <b>Move window (model):</b> ${formatDuration(setup.expectedMove)} · <b>Thesis expiry:</b> ${formatMinutes(setup.expectedMove.thesisExpiryMinutes)}`,
  ];
}

function finish(lines: string[]): string {
  const joined = lines.join('\n');
  if (joined.length <= MAX_CARD_CHARS) return joined;
  const kept: string[] = [];
  let used = 2;
  for (const line of lines) {
    if (used + line.length + 1 > MAX_CARD_CHARS) break;
    kept.push(line);
    used += line.length + 1;
  }
  return `${kept.join('\n')}\n…`;
}

/** Human-readable Telegram setup map; it describes trade hypotheses and timing, not guaranteed institutional intent. */
export function setupMapCard(map: SetupMap): string {
  const location = `${map.location} ${percent(map.positionPct)}`;
  const breakText = map.lastBreak
    ? `${map.lastBreak.type} ${map.lastBreak.direction} @ ${formatPrice(map.symbol, map.lastBreak.level)}`
    : 'none';
  const liquidity = `↑ ${map.nearestUpperLiquidity !== null ? formatPrice(map.symbol, map.nearestUpperLiquidity) : '—'} · ↓ ${map.nearestLowerLiquidity !== null ? formatPrice(map.symbol, map.nearestLowerLiquidity) : '—'}`;
  const crowd = map.crowding ?? 'BALANCED/UNKNOWN';
  const oi = map.openInterestExpansion === null ? '—' : map.openInterestExpansion ? 'EXPANDING' : 'NOT EXPANDING';
  const taker = map.takerAggressionRatio === null ? '—' : map.takerAggressionRatio.toFixed(2);

  const lines = [
    `<b>[ SETUP ]</b> ${clean(map.symbol)}`,
    `<b>🏦 INSTITUTIONAL-STYLE FLOW MAP</b> · ${map.state}`,
    `💵 <b>Price:</b> ${formatPrice(map.symbol, map.mark)} · <b>Bias:</b> ${map.bias} · <b>Regime:</b> ${clean(map.regime)}`,
    `📐 <b>Structure:</b> HTF ${map.htfTrend} · LTF ${map.ltfTrend} · <b>Last break:</b> ${clean(breakText)}`,
    `📍 <b>Location:</b> ${location} · <b>Vol:</b> ${map.volatility}`,
    `💧 <b>Liquidity:</b> ${liquidity}`,
    `👥 <b>Crowding:</b> ${clean(crowd)} · <b>OI:</b> ${oi} · <b>Taker:</b> ${taker}`,
    '',
    ...map.scenarios.flatMap((scenario, index) => [
      `<b>SETUP ${index + 1}</b>`,
      ...scenarioLines(map.symbol, { ...scenario }),
      '',
    ]),
    map.noTradeReasons.length > 0 ? `⚠️ <b>Context:</b> ${map.noTradeReasons.map(clean).join(' · ')}` : '✅ <b>Context:</b> no structural veto detected',
    `📝 <b>Execution:</b> setup map is deterministic; confirmation is required before order routing`,
    `🕒 <b>As of:</b> ${new Date(map.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST`,
  ];

  return finish(lines);
}
