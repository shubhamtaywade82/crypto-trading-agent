import type { MarketState } from '../market/types.js';

export interface ConflictCandidate {
  id: string;
  side: 'LONG' | 'SHORT';
  strategy: string;
  evidenceScore: number;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  rewardRisk?: number;
  factors?: string[];
}

export type ConflictResolutionVerdict = 'RESOLVED_LONG' | 'RESOLVED_SHORT' | 'STAND_DOWN';

export interface ConflictResolution {
  verdict: ConflictResolutionVerdict;
  winner: ConflictCandidate | null;
  ruleApplied: string;
  reason: string;
  longCandidate?: ConflictCandidate;
  shortCandidate?: ConflictCandidate;
}

function checkSqueezeOverride(
  longCand: ConflictCandidate,
  shortCand: ConflictCandidate,
  state: MarketState,
): ConflictResolution | null {
  const c = state.crowding;
  if (!c) return null;

  if (c.squeezeRisk === 'SHORT_SQUEEZE_RISK' || c.smartMoneyDivergence === 'SMART_MONEY_LONG') {
    if (longCand.evidenceScore >= 35) {
      return {
        verdict: 'RESOLVED_LONG',
        winner: longCand,
        ruleApplied: 'SQUEEZE_CONTRARIAN_OVERRIDE',
        reason: 'Short squeeze risk and smart money long divergence overrides short candidate',
      };
    }
  }

  if (c.squeezeRisk === 'LONG_SQUEEZE_RISK' || c.smartMoneyDivergence === 'SMART_MONEY_SHORT') {
    if (shortCand.evidenceScore >= 35) {
      return {
        verdict: 'RESOLVED_SHORT',
        winner: shortCand,
        ruleApplied: 'SQUEEZE_CONTRARIAN_OVERRIDE',
        reason: 'Long squeeze risk and smart money short divergence overrides long candidate',
      };
    }
  }

  return null;
}

function checkMeanReversionPriority(
  longCand: ConflictCandidate,
  shortCand: ConflictCandidate,
  state: MarketState,
): ConflictResolution | null {
  const mr = state.meanReversion;
  if (!mr?.rangeFavorable) return null;

  if (mr.reversionCandidate === 'BUY_CANDIDATE' && longCand.evidenceScore >= 35) {
    return {
      verdict: 'RESOLVED_LONG',
      winner: longCand,
      ruleApplied: 'RANGE_MEAN_REVERSION_PRIORITY',
      reason: 'Favorable range regime with confirmed Bollinger/RSI re-entry prioritizes long mean reversion',
    };
  }

  if (mr.reversionCandidate === 'SELL_CANDIDATE' && shortCand.evidenceScore >= 35) {
    return {
      verdict: 'RESOLVED_SHORT',
      winner: shortCand,
      ruleApplied: 'RANGE_MEAN_REVERSION_PRIORITY',
      reason: 'Favorable range regime with confirmed Bollinger/RSI re-entry prioritizes short mean reversion',
    };
  }

  return null;
}

function checkTrendDominance(
  longCand: ConflictCandidate,
  shortCand: ConflictCandidate,
  state: MarketState,
): ConflictResolution | null {
  const isTrendUp = state.regime.regime === 'TREND_UP' || (state.htfStructure.trend === 'BULLISH' && (state.regime.adx14 ?? 0) >= 20);
  const isTrendDown = state.regime.regime === 'TREND_DOWN' || (state.htfStructure.trend === 'BEARISH' && (state.regime.adx14 ?? 0) >= 20);

  if (isTrendUp && !isTrendDown && longCand.evidenceScore >= 35) {
    return {
      verdict: 'RESOLVED_LONG',
      winner: longCand,
      ruleApplied: 'TREND_REGIME_DOMINANCE',
      reason: 'Strong bullish trend regime vetoes counter-trend candidate',
    };
  }

  if (isTrendDown && !isTrendUp && shortCand.evidenceScore >= 35) {
    return {
      verdict: 'RESOLVED_SHORT',
      winner: shortCand,
      ruleApplied: 'TREND_REGIME_DOMINANCE',
      reason: 'Strong bearish trend regime vetoes counter-trend candidate',
    };
  }

  return null;
}

function checkScoreDominance(
  longCand: ConflictCandidate,
  shortCand: ConflictCandidate,
  conflictMargin: number,
): ConflictResolution {
  const diff = longCand.evidenceScore - shortCand.evidenceScore;
  if (diff >= conflictMargin) {
    return {
      verdict: 'RESOLVED_LONG',
      winner: longCand,
      ruleApplied: 'SCORE_DOMINANCE',
      reason: `Long candidate evidence score dominates by ${diff} points`,
    };
  }

  if (diff <= -conflictMargin) {
    return {
      verdict: 'RESOLVED_SHORT',
      winner: shortCand,
      ruleApplied: 'SCORE_DOMINANCE',
      reason: `Short candidate evidence score dominates by ${Math.abs(diff)} points`,
    };
  }

  return {
    verdict: 'STAND_DOWN',
    winner: null,
    ruleApplied: 'AMBIGUOUS_CONFLICT',
    reason: `Opposing signals within conflict margin (${Math.abs(diff)} < ${conflictMargin}) without dominant rule`,
  };
}

function checkStructuralReversal(
  longCand: ConflictCandidate,
  shortCand: ConflictCandidate,
  state: MarketState,
): ConflictResolution | null {
  const lastBreak = state.ltfStructure.lastBreak;
  if (!lastBreak || lastBreak.type !== 'CHOCH') return null;

  const sweeps = (state.liquidity.ltf.latestSweeps ?? []).concat(state.liquidity.ltf.recentSweeps ?? []);

  if (lastBreak.direction === 'BEARISH' && sweeps.some((s) => s.direction === 'BUY_SIDE' && s.confirmed)) {
    if (shortCand.evidenceScore >= 40 && shortCand.evidenceScore >= longCand.evidenceScore) {
      return {
        verdict: 'RESOLVED_SHORT',
        winner: shortCand,
        ruleApplied: 'STRUCTURAL_REVERSAL_OVERRIDE',
        reason: 'Confirmed buy-side sweep and bearish CHOCH overrides prevailing trend',
      };
    }
  }

  if (lastBreak.direction === 'BULLISH' && sweeps.some((s) => s.direction === 'SELL_SIDE' && s.confirmed)) {
    if (longCand.evidenceScore >= 40 && longCand.evidenceScore >= shortCand.evidenceScore) {
      return {
        verdict: 'RESOLVED_LONG',
        winner: longCand,
        ruleApplied: 'STRUCTURAL_REVERSAL_OVERRIDE',
        reason: 'Confirmed sell-side sweep and bullish CHOCH overrides prevailing trend',
      };
    }
  }

  return null;
}

export function resolveDirectionalConflict(
  longCandidate: ConflictCandidate,
  shortCandidate: ConflictCandidate,
  state: MarketState,
  conflictMargin = 15,
): ConflictResolution {
  const squeeze = checkSqueezeOverride(longCandidate, shortCandidate, state);
  if (squeeze) return squeeze;

  const reversal = checkStructuralReversal(longCandidate, shortCandidate, state);
  if (reversal) return reversal;

  const meanRev = checkMeanReversionPriority(longCandidate, shortCandidate, state);
  if (meanRev) return meanRev;

  const trend = checkTrendDominance(longCandidate, shortCandidate, state);
  if (trend) return trend;

  return checkScoreDominance(longCandidate, shortCandidate, conflictMargin);
}
