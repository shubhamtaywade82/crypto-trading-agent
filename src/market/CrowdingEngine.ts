import type { DerivativesSnapshot } from './MarketDataTypes.js';
import type { CrowdingSnapshot } from './types.js';

function deriveExtreme(
  globalLs: number | null,
  topTraderLs: number | null,
  fundingRate: number,
  takerRatio: number | null,
): CrowdingSnapshot['positioningExtreme'] {
  // Long crowding: top traders significantly skewed long, or global + positive funding
  const takerBuyHeavy = takerRatio !== null && takerRatio > 1.4;
  const takerSellHeavy = takerRatio !== null && takerRatio < 0.7;
  if ((topTraderLs !== null && topTraderLs >= 1.7) || (globalLs !== null && globalLs >= 1.5 && fundingRate > 0.0001) || takerBuyHeavy) {
    return 'LONG_CROWDED';
  }
  // Short crowding: top traders heavily short, or global + negative funding
  if ((topTraderLs !== null && topTraderLs <= 0.6) || (globalLs !== null && globalLs <= 0.7 && fundingRate < -0.0001) || takerSellHeavy) {
    return 'SHORT_CROWDED';
  }
  return 'BALANCED';
}

function emptyCrowding(): CrowdingSnapshot {
  return {
    fundingPercentile: null,
    fundingRegime: 'NEUTRAL',
    topTraderVsGlobalBias: null,
    positioningExtreme: 'BALANCED',
    takerAggressionRatio: null,
    takerImbalance: null,
    smartMoneyDivergence: 'NEUTRAL',
    crowdingScore: 0,
    squeezeRisk: 'NEUTRAL',
    openInterestExpansion: false,
    oiDeltaPct: null,
  };
}

function deriveFundingRegime(
  fundingRate: number,
): 'EXTREME_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'EXTREME_NEGATIVE' {
  if (fundingRate >= 0.0005) return 'EXTREME_POSITIVE';
  if (fundingRate > 0.00015) return 'POSITIVE';
  if (fundingRate <= -0.0005) return 'EXTREME_NEGATIVE';
  if (fundingRate < -0.00015) return 'NEGATIVE';
  return 'NEUTRAL';
}

function deriveDivergence(
  topTraderLs: number | null,
  globalLs: number | null,
): 'SMART_MONEY_LONG' | 'SMART_MONEY_SHORT' | 'NEUTRAL' {
  if (topTraderLs === null || globalLs === null || globalLs <= 0) return 'NEUTRAL';
  if (topTraderLs >= 1.3 && globalLs <= 0.8) return 'SMART_MONEY_LONG';
  if (topTraderLs <= 0.8 && globalLs >= 1.3) return 'SMART_MONEY_SHORT';
  return 'NEUTRAL';
}

function deriveCrowdingScore(
  globalLs: number | null,
  fundingRate: number,
  takerRatio: number | null,
): number {
  const fundingComponent = Math.max(-1, Math.min(1, fundingRate / 0.0005));
  const lsComponent = globalLs !== null ? Math.max(-1, Math.min(1, (globalLs - 1.0) / 1.0)) : 0;
  const takerComponent = takerRatio !== null ? Math.max(-1, Math.min(1, (takerRatio - 1.0) / 0.5)) : 0;

  const score = fundingComponent * 0.35 + lsComponent * 0.40 + takerComponent * 0.25;
  return Math.max(-1, Math.min(1, Math.round(score * 100) / 100));
}

function deriveSqueezeRisk(
  crowdingScore: number,
  extreme: CrowdingSnapshot['positioningExtreme'],
  expandingOi: boolean,
): 'LONG_SQUEEZE_RISK' | 'SHORT_SQUEEZE_RISK' | 'NEUTRAL' {
  if (expandingOi && (extreme === 'LONG_CROWDED' || crowdingScore >= 0.5)) {
    return 'LONG_SQUEEZE_RISK';
  }
  if (expandingOi && (extreme === 'SHORT_CROWDED' || crowdingScore <= -0.5)) {
    return 'SHORT_SQUEEZE_RISK';
  }
  return 'NEUTRAL';
}

/** Computes participant crowding and positioning asymmetry from derivatives data. */
export function calculateCrowding(
  derivatives: DerivativesSnapshot | null,
  fundingRate: number
): CrowdingSnapshot {
  if (!derivatives) return emptyCrowding();

  const globalLs = derivatives.globalLongShortRatio;
  const topTraderLs = derivatives.topTraderPositionLongShortRatio ?? derivatives.topTraderAccountLongShortRatio;
  const topTraderVsGlobalBias =
    topTraderLs !== null && globalLs !== null && globalLs > 0
      ? topTraderLs / globalLs
      : null;

  // Approximate funding percentile from rate magnitude (0.01% baseline = 50th percentile)
  const fundingPercentile = Math.max(0, Math.min(100, 50 + (fundingRate / 0.0005) * 50));
  const oiDeltaPct = derivatives.openInterestChangePct ?? null;
  const openInterestExpansion = oiDeltaPct !== null && oiDeltaPct > 1.5;
  const extreme = deriveExtreme(globalLs, topTraderLs, fundingRate, derivatives.takerBuySellRatio);
  const crowdingScore = deriveCrowdingScore(globalLs, fundingRate, derivatives.takerBuySellRatio);

  return {
    fundingPercentile,
    fundingRegime: deriveFundingRegime(fundingRate),
    topTraderVsGlobalBias,
    positioningExtreme: extreme,
    takerAggressionRatio: derivatives.takerBuySellRatio,
    takerImbalance: derivatives.takerVolumeImbalance ?? null,
    smartMoneyDivergence: deriveDivergence(topTraderLs, globalLs),
    crowdingScore,
    squeezeRisk: deriveSqueezeRisk(crowdingScore, extreme, openInterestExpansion),
    openInterestExpansion,
    oiDeltaPct,
  };
}
