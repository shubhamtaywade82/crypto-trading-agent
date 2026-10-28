import type { MarketState, ZoneRecord } from '../market/types.js';
import type { SetupMap, SetupScenario } from '../decision/SetupTypes.js';
import type {
  BriefAction,
  ConditionalScenarioSummary,
  DataQualityReport,
  DeterministicLevels,
  MarketBias,
  MarketBriefDecision,
} from './types.js';

// Resolves structural directional bias across high and low timeframes
function resolveMarketBias(state: MarketState): MarketBias {
  const htf = state.htfStructure.trend;
  const ltf = state.ltfStructure.trend;

  if (htf === 'BULLISH' && ltf === 'BULLISH') return 'BULLISH';
  if (htf === 'BEARISH' && ltf === 'BEARISH') return 'BEARISH';
  if (state.regime.trendDirection === 'BULLISH') return 'BULLISH';
  if (state.regime.trendDirection === 'BEARISH') return 'BEARISH';
  return 'MIXED';
}

// Extracts tightest support and resistance zones from liquidity and cause zones
function extractKeyLevels(state: MarketState): DeterministicLevels {
  const mark = state.mark;
  const zones = state.zones.filter((z) => Number.isFinite(z.low) && Number.isFinite(z.high));

  const supports = zones
    .filter((z) => z.high <= mark)
    .sort((a, b) => b.high - a.high);
  const resistances = zones
    .filter((z) => z.low >= mark)
    .sort((a, b) => a.low - b.low);

  const bestSup = supports[0];
  const bestRes = resistances[0];

  return {
    support: bestSup ? [bestSup.low, bestSup.high] : null,
    resistance: bestRes ? [bestRes.low, bestRes.high] : null,
    equilibrium: state.pricing.equilibrium,
  };
}

// Builds explicit conditional trigger and failure expectations for both market sides
function buildConditionalScenarios(levels: DeterministicLevels): ConditionalScenarioSummary {
  const resLabel = levels.resistance ? `$${levels.resistance[0].toFixed(2)}–$${levels.resistance[1].toFixed(2)}` : 'key resistance';
  const supLabel = levels.support ? `$${levels.support[0].toFixed(2)}–$${levels.support[1].toFixed(2)}` : 'key support';

  return {
    bullishCondition: `Confirmed 15m close and successful retest above ${resLabel}.`,
    bearishCondition: `Confirmed 15m close and failed reclaim below ${supLabel}.`,
  };
}

// Evaluates deterministic suitability gate for a candidate setup scenario
function evaluateScenarioAction(
  scenario: SetupScenario,
  bias: MarketBias
): { action: BriefAction; reasons: string[] } {
  if (scenario.state !== 'TRIGGERED') {
    return { action: 'NO_TRADE', reasons: ['INSUFFICIENT_CONFIRMATION'] };
  }

  if (scenario.quality?.verdict !== 'ENTRY_ELIGIBLE') {
    return { action: 'NO_TRADE', reasons: ['RISK_OR_QUALITY_GATE'] };
  }

  // Directional filter: prevents trading against unified higher-timeframe trends
  const opposed = (scenario.direction === 'LONG' && bias === 'BEARISH') ||
                  (scenario.direction === 'SHORT' && bias === 'BULLISH');
  if (opposed) {
    return { action: 'NO_TRADE', reasons: ['CONFLICTING_EVIDENCE'] };
  }

  return {
    action: scenario.direction === 'LONG' ? 'BUY_LONG' : 'SELL_SHORT',
    reasons: [],
  };
}

// Deterministic decision gate: defaults to NO_TRADE unless all safety and trigger criteria hold
export function evaluateBriefDecision(
  quality: DataQualityReport,
  state: MarketState | null,
  map: SetupMap | null,
  now: number = Date.now()
): { decision: MarketBriefDecision; levels: DeterministicLevels; scenarios: ConditionalScenarioSummary } {
  if (quality.status === 'INVALID' || !state) {
    return {
      decision: {
        bias: 'MIXED',
        action: 'NO_TRADE',
        reasonCodes: ['DATA_QUALITY_BLOCKED', ...quality.reasons],
        evaluatedAt: now,
      },
      levels: { support: null, resistance: null, equilibrium: null },
      scenarios: {
        bullishCondition: 'Data quality blocked: valid exchange feed required.',
        bearishCondition: 'Data quality blocked: valid exchange feed required.',
      },
    };
  }

  const bias = resolveMarketBias(state);
  const levels = extractKeyLevels(state);
  const scenarios = buildConditionalScenarios(levels);

  const triggered = map?.scenarios.find((s) => s.state === 'TRIGGERED');
  const candidate = triggered ?? map?.scenarios[0];

  if (!candidate) {
    return {
      decision: {
        bias,
        action: 'NO_TRADE',
        reasonCodes: ['NO_VALID_SETUP'],
        evaluatedAt: now,
      },
      levels,
      scenarios,
    };
  }

  const result = evaluateScenarioAction(candidate, bias);
  return {
    decision: {
      bias,
      action: result.action,
      reasonCodes: result.reasons.length > 0 ? result.reasons : ['SETUP_QUALIFIED'],
      confirmedTrigger: candidate.state === 'TRIGGERED' ? candidate.trigger : undefined,
      invalidation: candidate.invalidation,
      scenarioId: candidate.id,
      evaluatedAt: now,
    },
    levels,
    scenarios,
  };
}
