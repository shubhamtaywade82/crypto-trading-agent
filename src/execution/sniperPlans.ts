import type { PlanResult, TradePlan, TradePlanLedger } from '../ops/tradePlans.js';
import type { SniperPosition } from './SmartMoneySniper.js';

/**
 * Sniper positions as trade plans. The sniper places no venue order: its entry is the alert price and its exit is
 * decided by polling, so the recorded outcome is the sniper's own simulated result. Recovery reads the same ledger,
 * so a restart neither re-alerts a signal already announced nor forgets a position that still needs its exit.
 */

export const SNIPER_STRATEGY = 'SNIPER';

export const sniperPlanId = (signalId: number): string => `SNIPER:${signalId}`;

const EXIT_RESULT: Readonly<Record<Exclude<SniperPosition['status'], 'OPEN'>, PlanResult>> = {
  TP_HIT: 'TP', SL_HIT: 'SL', EXPIRED: 'TIME_STOP',
};

export interface RestoredSniperState {
  readonly processedSignalIds: Set<number>;
  readonly openPositions: Map<number, SniperPosition>;
  /** Plans that could not be rebuilt into a watchable position (missing or mistyped meta). Reported, never guessed at. */
  readonly unrecoverable: number;
}

/** Writes a new sniper position as announced and filled at its alert price. Returns the plan id when it was written. */
export function announceSniperPlan(plans: TradePlanLedger, pos: SniperPosition): string | undefined {
  const planId = sniperPlanId(pos.signalId);
  const announced = plans.announce({
    planId, source: 'SNIPER', symbol: pos.ticker, side: 'LONG', strategy: SNIPER_STRATEGY, at: pos.entryTimeMs,
    planned: { entry: pos.entryPrice, stopLoss: pos.stopPrice, takeProfit: pos.targetPrice },
    meta: {
      signalId: pos.signalId, chainId: pos.chainId, contractAddress: pos.contractAddress,
      expiryTimeMs: pos.expiryTimeMs, positionSizeUsd: pos.positionSizeUsd,
    },
  });
  if (!announced.applied) return undefined;
  plans.fill(planId, pos.entryTimeMs);
  return planId;
}

/** Records a terminal sniper position (TP, SL or time stop). An OPEN position is not an outcome and is ignored. */
export function recordSniperExit(plans: TradePlanLedger, pos: SniperPosition, at: number): string | undefined {
  if (pos.status === 'OPEN') return undefined;
  const planId = sniperPlanId(pos.signalId);
  const closed = plans.close(planId, {
    at, result: EXIT_RESULT[pos.status], exitPrice: pos.exitPrice ?? null, entryPrice: pos.entryPrice, pnl: pos.realizedPnlUsd ?? null,
  });
  return closed.applied ? planId : undefined;
}

const positionFrom = (plan: TradePlan, signalId: number): SniperPosition | undefined => {
  const { chainId, contractAddress, expiryTimeMs, positionSizeUsd } = plan.meta;
  if (typeof chainId !== 'string' || typeof contractAddress !== 'string') return undefined;
  if (typeof expiryTimeMs !== 'number' || typeof positionSizeUsd !== 'number' || plan.filledAt === null) return undefined;
  return {
    signalId,
    ticker: plan.symbol,
    chainId,
    contractAddress,
    entryPrice: plan.planned.entry,
    targetPrice: plan.planned.takeProfit,
    stopPrice: plan.planned.stopLoss,
    entryTimeMs: plan.filledAt,
    expiryTimeMs,
    positionSizeUsd,
    status: 'OPEN',
  };
};

/**
 * Rebuilds the sniper's in-memory state from the ledger. Every signal ever announced stays processed, so a restart
 * does not alert it again. Every position still FILLED is watched again, so its TP, SL or time stop still gets reported.
 */
export function restoreSniperState(plans: TradePlanLedger): RestoredSniperState {
  const processedSignalIds = new Set<number>();
  const openPositions = new Map<number, SniperPosition>();
  let unrecoverable = 0;
  for (const plan of plans.all()) {
    if (plan.source !== 'SNIPER') continue;
    const signalId = plan.meta.signalId;
    if (typeof signalId !== 'number') { unrecoverable += 1; continue; }
    processedSignalIds.add(signalId);
    if (plan.status !== 'FILLED') continue;
    const position = positionFrom(plan, signalId);
    if (position) openPositions.set(signalId, position);
    else unrecoverable += 1;
  }
  return { processedSignalIds, openPositions, unrecoverable };
}
