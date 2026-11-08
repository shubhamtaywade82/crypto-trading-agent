import type { Candle, Position } from '../types.js';
import { evaluate } from './engine.js';
import { atrOf } from './price.js';
import { buildPolicy, PHASE1_METHODS } from './registry.js';
import { confirmStop, initState } from './stateMachine.js';
import type { PolicyContext, TrailingDecision, TrailingPolicy, TrailingState } from './types.js';

export type TrailingEngineMode = 'off' | 'shadow';

const TIMEFRAME = '15m';
const CANDLE_LIMIT = 200;
// Candles feed 15m policies, so refreshing once a minute is plenty and keeps kline weight off the venue budget.
const CANDLE_TTL_MS = 60_000;

const PHASE1_POLICIES: readonly TrailingPolicy[] = PHASE1_METHODS.map((method) => buildPolicy(`${method}-v1`, method, {}));

interface ShadowDeps {
  getKlines: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
  log: (message: string) => void;
  now?: () => number;
}

/**
 * Trailing engine in shadow (spec 2026-11-03, phase 4 without execution): evaluates the phase-1 policies on every
 * open position and logs the stop moves and exits it would make. It sends nothing. The position manager stays the
 * only stop mover; a second mover on the same legs would fight it.
 */
export class TrailingShadow {
  private readonly states = new Map<string, TrailingState>();
  private readonly exited = new Set<string>();
  private readonly candles = new Map<string, { at: number; rows: Candle[] }>();
  private readonly now: () => number;

  constructor(private readonly deps: ShadowDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One manage pass: returns the non-HOLD decisions it logged. */
  async observe(positions: Position[]): Promise<TrailingDecision[]> {
    const live = new Set(positions.map((p) => `${p.symbol}:${p.strategy}`));
    for (const key of [...this.states.keys()]) if (!live.has(key)) { this.states.delete(key); this.exited.delete(key); }
    const decisions: TrailingDecision[] = [];
    for (const position of positions) {
      const decision = await this.observeOne(position);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }

  private async observeOne(position: Position): Promise<TrailingDecision | null> {
    const key = `${position.symbol}:${position.strategy}`;
    if (this.exited.has(key)) return null;
    const prev = this.states.get(key) ?? initState(position, this.now());
    if (!prev) return null;
    const ctx = this.contextFor(position, await this.candlesFor(position.symbol));
    const { state, decision } = evaluate(prev, ctx, PHASE1_POLICIES, this.now());
    if (decision.action === 'HOLD') { this.states.set(key, state); return null; }
    if (decision.action === 'EXIT') {
      this.exited.add(key);
      this.deps.log(`TRAIL (shadow) ${position.symbol} ${position.side}: would EXIT at ${position.mark} (${decision.reasonCode})`);
      return decision;
    }
    // Shadow ACKs its own move so the ratchet advances as it would with an executor confirming every stop.
    this.states.set(key, confirmStop(state, String(decision.evidence.acceptingPolicyId ?? ''), this.now()));
    this.deps.log(`TRAIL (shadow) ${position.symbol} ${position.side}: would move stop to ${decision.stopPrice} (${decision.reasonCode})`);
    return decision;
  }

  private contextFor(position: Position, candles: Candle[]): PolicyContext {
    const atr = atrOf(candles, 14);
    return {
      position,
      s: position.side === 'LONG' ? 1 : -1,
      tf: TIMEFRAME,
      price: position.mark,
      mark: { price: position.mark, fundingRate: 0, nextFundingAt: 0 },
      index: null,
      book: null,
      flow: null,
      atr: { contract: atr, mark: atr },
      candles,
      tickSize: null,
      account: { fundingAccrued: 0, feesAccrued: 0, fundingSettledAt: [] },
    };
  }

  private async candlesFor(symbol: string): Promise<Candle[]> {
    const cached = this.candles.get(symbol);
    if (cached && this.now() - cached.at < CANDLE_TTL_MS) return cached.rows;
    const rows = await this.deps.getKlines(symbol, TIMEFRAME, CANDLE_LIMIT);
    this.candles.set(symbol, { at: this.now(), rows });
    return rows;
  }
}
