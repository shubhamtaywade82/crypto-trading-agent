import { fmt, bold, type FormattedMessage } from '@nemesis-oss/tg-format';
import type { MarketBrief, TakerFlowBucket } from './types.js';

function formatFlowLabel(bucket?: TakerFlowBucket): string {
  const ratio = bucket?.buySellRatio;
  if (!ratio || !Number.isFinite(ratio)) return 'unavailable';
  if (ratio >= 1.1) return 'buy-dominant';
  if (ratio <= 0.9) return 'sell-dominant';
  return 'balanced';
}

function formatLevelRange(range: readonly [number, number] | null): string {
  return range ? `$${range[0].toFixed(2)}–$${range[1].toFixed(2)}` : 'none detected';
}

// Formats UTC time as HH:MM UTC for brief header
function formatUtcStamp(timestamp: number): string {
  const d = new Date(timestamp);
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes} UTC`;
}

// Builds typed FormattedMessage with native Telegram entities using @nemesis-oss/tg-format
export function formatMarketBriefMessage(brief: MarketBrief): FormattedMessage {
  const { symbol, generatedAt, dataQuality, market, timeframes, derivatives, decision, levels, scenarios } = brief;

  const lastPrice = market.lastPrice ? `$${market.lastPrice.toFixed(2)}` : 'N/A';
  const change24h = market.change24hPct !== null
    ? `${market.change24hPct >= 0 ? '+' : ''}${market.change24hPct.toFixed(2)}%`
    : 'N/A';

  const structureLine = [
    `5m ${timeframes['5m'].bias.toLowerCase()}`,
    `15m ${timeframes['15m'].bias.toLowerCase()}`,
    `1h ${timeframes['1h'].bias.toLowerCase()}`,
    `4h ${timeframes['4h'].bias.toLowerCase()}`,
  ].join(' · ');

  const fundingText = derivatives.fundingRate !== null
    ? `${derivatives.fundingRate >= 0 ? '+' : ''}${(derivatives.fundingRate * 100).toFixed(4)}%`
    : 'N/A';
  const oiDeltaText = derivatives.openInterestChangePct !== null
    ? `${derivatives.openInterestChangePct >= 0 ? '+' : ''}${derivatives.openInterestChangePct.toFixed(2)}%`
    : 'N/A';
  const glsText = derivatives.globalLongShortRatio !== null
    ? derivatives.globalLongShortRatio.toFixed(2)
    : 'N/A';

  const flowLine = [
    `5m ${formatFlowLabel(derivatives.takerFlowByPeriod['5m'])}`,
    `15m ${formatFlowLabel(derivatives.takerFlowByPeriod['15m'])}`,
    `1h ${formatFlowLabel(derivatives.takerFlowByPeriod['1h'])}`,
  ].join(' · ');

  const reasonLine = decision.action === 'NO_TRADE'
    ? decision.reasonCodes.join('; ')
    : decision.confirmedTrigger ?? 'Trigger confirmed';

  const actionText = decision.action.replace('_', ' ');
  const reasonHeading = decision.action === 'NO_TRADE' ? 'Why no trade:' : 'Trade context:';

  return fmt`${bold(`## ${symbol} · USDⓈ-M`)}
${bold(actionText)}

Generated at ${formatUtcStamp(generatedAt)} · Data quality: ${bold(dataQuality.status)}
Price: ${bold(lastPrice)} · 24h: ${bold(change24h)}

Structure: ${structureLine}
Derivatives: Funding ${fundingText} · OI Δ ${oiDeltaText} · Global L/S ${glsText}
Flow: ${flowLine}

Key levels: Support ${formatLevelRange(levels.support)} · Resistance ${formatLevelRange(levels.resistance)}

${bold('Bullish condition:')} ${scenarios.bullishCondition}
${bold('Bearish condition:')} ${scenarios.bearishCondition}

${bold(reasonHeading)} ${reasonLine}`;
}

// Produces structured, copy-paste ready HTML cards for Telegram broadcast
export function formatMarketBriefCard(brief: MarketBrief): string {
  return formatMarketBriefMessage(brief).toHTML();
}
