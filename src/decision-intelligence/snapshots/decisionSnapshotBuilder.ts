/**
 * DecisionSnapshotBuilder: normalizes a trade candidate and the computed market
 * facts into the compact `state` payload the decision model judges.
 *
 * Contract (from the Tev1 integration design):
 *  - computed facts only — never raw candle history; the model is not asked to
 *    discover structure, compute indicators or price the candidate;
 *  - every unavailable fact is declared missing, never guessed or substituted;
 *  - the serialized snapshot stays inside the ~2,000-token budget the model's
 *    README recommends (enforced as SNAPSHOT_JSON_BUDGET in tests).
 *
 * A MarketState is computed on confirmed candles only (MarketDataService drops
 * any candle whose interval has not fully closed), so the snapshot can honestly
 * state closedCandlesOnly: true — forming-bar evidence never reaches this layer.
 */

import type { MarketState } from '../../market/types.js';
import type { DecisionEvidence } from '../../decision/DecisionJournal.js';
import type { Signal } from '../../types.js';
import type { DecisionSnapshot, TimeframeFacts } from '../types.js';
import { SNAPSHOT_JSON_BUDGET } from '../types.js';

/** Input to the builder: exactly what the live loop already computes for a gated candidate. */
export interface DecisionSnapshotInput {
  signal: Signal;
  state: MarketState | undefined;
  evidence: DecisionEvidence;
  now: number;
}

/**
 * A MarketState is stamped with the openTime of the last CLOSED 15m candle, so a
 * fresh state is 15–30 minutes old by construction. Anything past this budget
 * means the feed itself stalled, and the candidate must not be judged on it.
 */
export const STALE_MARKET_STATE_MS = 45 * 60_000;

/** Most reasons a strategy can emit are one sentence; the model needs the gist, not the prose. */
const MAX_EVIDENCE_REASONS = 3;
const MAX_REASON_LENGTH = 96;

/** 5 significant digits keep cent-level precision on two-digit prices and stay compact in tokens. */
function price(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value === 0) return 0;
  const digits = Math.max(0, 5 - Math.floor(Math.log10(Math.abs(value))) - 1);
  return Number(value.toFixed(digits));
}

function pct(value: number | null | undefined, digits = 2): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Number((value * 100).toFixed(digits)) : null;
}

function ratio(value: number | null | undefined, digits = 3): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function trendOf(state: MarketState | undefined, timeframe: '15m' | '1h' | '4h'): TimeframeFacts | null {
  const tf = state?.timeframes[timeframe];
  if (!tf) return null;
  const structure = timeframe === '4h' ? state.htfStructure : timeframe === '15m' ? state.ltfStructure : null;
  const lastBreak = structure?.lastBreak;
  return {
    trend: structure?.trend ?? 'NEUTRAL',
    structure: lastBreak ? `${lastBreak.type}_${lastBreak.direction}@${price(lastBreak.level)}` : 'NO_BREAK',
    adx14: ratio(tf.adx14, 1),
    rsi14: ratio(tf.rsi14, 1),
    atrPct: tf.atr14 !== null ? ratio((tf.atr14 / (tf.lastClose || 1)) * 100, 2) : null,
  };
}

/**
 * Builds the snapshot, or returns null when the candidate itself cannot be
 * judged: a candidate without complete entry/stop/target geometry has no
 * risk/reward to validate, and the caller must treat that as a non-approval in
 * enforced mode rather than asking the model to guess.
 */
export function buildDecisionSnapshot(input: DecisionSnapshotInput): DecisionSnapshot | null {
  const { signal, state, evidence, now } = input;
  const side: 'LONG' | 'SHORT' = signal.type.includes('SHORT') ? 'SHORT' : 'LONG';
  const entry = signal.entry ?? null;
  const stopLoss = signal.stopLoss ?? null;
  const takeProfit = signal.takeProfit ?? null;
  if (entry === null || stopLoss === null || takeProfit === null) return null;

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (!(risk > 0) || !Number.isFinite(reward)) return null;

  const missingFeatures: string[] = [];
  const derivatives = state?.derivatives ?? null;
  const crowding = state?.crowding ?? null;
  if (!state) missingFeatures.push('market_state');
  if (!crowding) missingFeatures.push('crowding');

  const orderFlow = {
    takerBuySellRatio: ratio(derivatives?.takerBuySellRatio ?? null, 4),
    openInterestChangePct: pct(derivatives?.openInterestChangePct ?? null),
    globalLongShortRatio: derivatives?.globalLongShortRatio ?? null,
    orderBookImbalance: ratio(derivatives?.orderBookImbalance ?? null, 3),
    spreadBps: ratio(derivatives?.spreadBps ?? null, 1),
  };
  for (const [feature, value] of Object.entries(orderFlow)) {
    if (value === null) missingFeatures.push(feature);
  }

  const marketStateAgeMs = state ? now - state.generatedAt : null;
  const tf4h = trendOf(state, '4h');
  const tf1h = trendOf(state, '1h');
  const tf15m = trendOf(state, '15m');
  const snapshot: DecisionSnapshot = {
    symbol: signal.symbol,
    venue: 'BINANCE_USDM',
    decisionTimeframe: '15m',
    asOf: now,
    market: state
      ? {
          regime: state.regime.regime,
          trendDirection: state.regime.trendDirection,
          trendStrength: ratio(state.regime.trendStrength, 2) ?? 0,
          volatility: state.regime.volatility,
          mark: price(state.mark),
          fundingRatePct: pct(state.fundingRate, 4),
          rangePositionPct: ratio(state.pricing.positionPct, 1),
        }
      : {
          regime: 'UNKNOWN',
          trendDirection: 'NEUTRAL',
          trendStrength: 0,
          volatility: 'UNKNOWN',
          mark: price(entry),
          fundingRatePct: null,
          rangePositionPct: null,
        },
    higherTimeframes: state
      ? {
          ...(tf4h ? { '4h': tf4h } : {}),
          ...(tf1h ? { '1h': tf1h } : {}),
          ...(tf15m ? { '15m': tf15m } : {}),
        }
      : {},
    setup: {
      type: signal.type,
      side,
      strategy: signal.agent,
      entry: price(entry),
      stopLoss: price(stopLoss),
      takeProfit: price(takeProfit),
      riskReward: Number((reward / risk).toFixed(2)),
      evidenceScore: evidence.score,
      evidenceReasons: evidence.factors.slice(0, MAX_EVIDENCE_REASONS).map((reason) => reason.slice(0, MAX_REASON_LENGTH)),
    },
    orderFlow,
    positioning: {
      positioningExtreme: crowding?.positioningExtreme ?? null,
      fundingPercentile: crowding?.fundingPercentile ?? null,
      topTraderVsGlobalBias: ratio(crowding?.topTraderVsGlobalBias ?? null, 2),
    },
    dataQuality: {
      marketStatePresent: state !== undefined,
      marketStateAgeMs,
      stale: marketStateAgeMs !== null && marketStateAgeMs > STALE_MARKET_STATE_MS,
      closedCandlesOnly: true,
      missingFeatures,
    },
  };
  return snapshot;
}

/** Serialized size of a snapshot, for the token-budget check. */
export function snapshotJsonLength(snapshot: DecisionSnapshot): number {
  return JSON.stringify(snapshot).length;
}

/** True when the snapshot fits the soft character budget (~4 chars/token). Exported for tests and ops scripts. */
export function snapshotWithinBudget(snapshot: DecisionSnapshot): boolean {
  return snapshotJsonLength(snapshot) <= SNAPSHOT_JSON_BUDGET;
}
