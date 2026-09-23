import type { DerivativesSnapshot } from './MarketDataTypes.js';
import type { CrowdingSnapshot } from './types.js';

function deriveExtreme(
  globalLs: number | null,
  topTraderLs: number | null,
  fundingRate: number
): CrowdingSnapshot['positioningExtreme'] {
  // Extreme long crowding: high long/short ratio accompanied by elevated positive funding
  if ((globalLs !== null && globalLs >= 2.0 && fundingRate > 0.0003) || (topTraderLs !== null && topTraderLs >= 2.5)) {
    return 'LONG_CROWDED';
  }
  // Extreme short crowding: low long/short ratio accompanied by negative funding
  if ((globalLs !== null && globalLs <= 0.6 && fundingRate < -0.0003) || (topTraderLs !== null && topTraderLs <= 0.45)) {
    return 'SHORT_CROWDED';
  }
  return 'BALANCED';
}

/** Computes participant crowding and positioning asymmetry from derivatives data. */
export function calculateCrowding(
  derivatives: DerivativesSnapshot | null,
  fundingRate: number
): CrowdingSnapshot {
  if (!derivatives) {
    return {
      fundingPercentile: null,
      topTraderVsGlobalBias: null,
      positioningExtreme: 'BALANCED',
      takerAggressionRatio: null,
      openInterestExpansion: false,
    };
  }

  const globalLs = derivatives.globalLongShortRatio;
  const topTraderLs = derivatives.topTraderPositionLongShortRatio ?? derivatives.topTraderAccountLongShortRatio;
  const topTraderVsGlobalBias =
    topTraderLs !== null && globalLs !== null && globalLs > 0
      ? topTraderLs / globalLs
      : null;

  // Approximate funding percentile from rate magnitude (0.01% baseline = 50th percentile)
  const fundingPercentile = Math.max(0, Math.min(100, 50 + (fundingRate / 0.0005) * 50));
  const oiChange = derivatives.openInterestChangePct ?? 0;
  const openInterestExpansion = oiChange > 1.5;

  return {
    fundingPercentile,
    topTraderVsGlobalBias,
    positioningExtreme: deriveExtreme(globalLs, topTraderLs, fundingRate),
    takerAggressionRatio: derivatives.takerBuySellRatio,
    openInterestExpansion,
  };
}
