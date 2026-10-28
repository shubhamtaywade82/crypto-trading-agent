import type { MarketBrief } from './types.js';

export interface BriefDiffResult {
  readonly isMaterialChange: boolean;
  readonly changes: readonly string[];
}

// Compares two sequential market briefs to isolate actionable or structural transitions
export function diffMarketBriefs(
  current: MarketBrief,
  previous?: MarketBrief | null
): BriefDiffResult {
  if (!previous) {
    return {
      isMaterialChange: true,
      changes: ['initial market baseline established'],
    };
  }

  const changes: string[] = [];

  // Action flips are always high-priority material alerts
  if (current.decision.action !== previous.decision.action) {
    changes.push(`action changed: ${previous.decision.action} → ${current.decision.action}`);
  }

  // Structural bias flips
  if (current.decision.bias !== previous.decision.bias) {
    changes.push(`bias flipped: ${previous.decision.bias} → ${current.decision.bias}`);
  }

  // Data quality status degradation or recovery
  if (current.dataQuality.status !== previous.dataQuality.status) {
    changes.push(`data quality: ${previous.dataQuality.status} → ${current.dataQuality.status}`);
  }

  // Active setup scenario transitions
  if (current.decision.scenarioId !== previous.decision.scenarioId) {
    changes.push(`scenario transitioned: ${previous.decision.scenarioId ?? 'none'} → ${current.decision.scenarioId ?? 'none'}`);
  }

  // Significant price moves (> 1% between briefs)
  const prevPrice = previous.market.lastPrice;
  const currPrice = current.market.lastPrice;
  if (prevPrice && currPrice && prevPrice > 0) {
    const movePct = Math.abs((currPrice - prevPrice) / prevPrice) * 100;
    if (movePct >= 1.0) {
      const dir = currPrice > prevPrice ? '+' : '-';
      changes.push(`material price shift: ${dir}${movePct.toFixed(2)}% ($${prevPrice} → $${currPrice})`);
    }
  }

  const isMaterialChange = changes.some((c) =>
    c.startsWith('action changed:') ||
    c.startsWith('bias flipped:') ||
    c.startsWith('data quality: INVALID')
  );

  return {
    isMaterialChange,
    changes,
  };
}
