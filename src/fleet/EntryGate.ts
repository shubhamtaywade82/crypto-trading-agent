import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KillSwitch } from '../ops/killSwitch.js';
import {
  circuitRiskMultiplier, deriveCircuitState, riskLimitsFromConfig, type CircuitState, type RiskLimits,
} from '../risk/riskConfig.js';

/**
 * Deterministic gate on fleet ENTRIES. It reuses the repo's own circuit breaker (daily loss, loss streak and drawdown, against
 * the MAX_* settings in config.risk), the operator kill switch, and a freshness check on the live trade feed. Exits never pass
 * through it: a position must always be closable.
 *
 * The fleet does not use the cockpit's full RiskEngine. Its exposure caps are percentages of equity, and a 10x fleet position is
 * roughly 980% of its $1,000 account, so that check would refuse every fleet entry.
 */

/** A worker refuses entries once no live trade tick has arrived for this long: the decision would rest on stale prices. */
export const MAX_LIVE_TICK_AGE_MS = 15_000;

/** Per-symbol governor state. Persisted, so a restart cannot reset the drawdown high-water mark or the loss streak. */
export interface GovernorSymbolState {
  /** Highest equity seen. Drawdown is measured from here. */
  hwm: number;
  /** Equity at the most recent observation. */
  lastEquity: number;
  /** UTC day (YYYY-MM-DD) that the two day fields below belong to. */
  dayKey: string;
  dayStartEquity: number;
  /** Realized PnL of exits closed on `dayKey`: the worker's exit PnL, gross of fees. */
  dayRealizedPnl: number;
  /** Consecutive losing exits. Only a winning exit clears it. */
  lossStreak: number;
}

export interface EntryGateInput {
  now: number;
  /** Venue equity from the last account sync; null before the first successful sync. */
  equity: number | null;
  /** Epoch ms of the last live trade tick delivered to the worker; 0 when none has arrived. */
  lastLiveTickAt: number;
}

export interface EntryGateDecision {
  allowed: boolean;
  /** Multiplier on the per-trade risk budget: 1 normal, 0.75 caution, 0.5 reduced, 0 when refused. */
  riskMultiplier: number;
  circuit: CircuitState;
  reasons: string[];
}

/** What a worker needs from its gate. The worker holds one; tests inject their own. */
export interface EntryGate {
  decide(input: EntryGateInput): EntryGateDecision;
  observeEquity(equity: number, now: number): void;
  recordExit(pnl: number, now: number): void;
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The state after an equity observation. A new UTC day restarts the day's anchors; the high-water mark only rises. */
export function observeEquityState(prev: GovernorSymbolState | undefined, equity: number, now: number): GovernorSymbolState {
  const dayKey = utcDayKey(now);
  if (!prev) {
    return { hwm: equity, lastEquity: equity, dayKey, dayStartEquity: equity, dayRealizedPnl: 0, lossStreak: 0 };
  }
  const hwm = Math.max(prev.hwm, equity);
  if (prev.dayKey !== dayKey) {
    return { ...prev, hwm, lastEquity: equity, dayKey, dayStartEquity: equity, dayRealizedPnl: 0 };
  }
  return { ...prev, hwm, lastEquity: equity };
}

/** The state after a closed exit. A loss extends the streak, a win clears it, and a breakeven leaves it alone. */
export function recordExitState(prev: GovernorSymbolState, pnl: number, now: number): GovernorSymbolState {
  const dayKey = utcDayKey(now);
  const base = prev.dayKey === dayKey ? prev : { ...prev, dayKey, dayStartEquity: prev.lastEquity, dayRealizedPnl: 0 };
  const lossStreak = pnl < 0 ? base.lossStreak + 1 : pnl > 0 ? 0 : base.lossStreak;
  return { ...base, dayRealizedPnl: base.dayRealizedPnl + pnl, lossStreak };
}

export interface EntryGateContext {
  operatorHalted: boolean;
  maxTickAgeMs: number;
  limits: RiskLimits;
  state: GovernorSymbolState | undefined;
  /** Set when the persisted state could not be read. Entries stay refused until the file is repaired or removed. */
  stateError?: string;
}

/** Pure. Every refusal reason is collected, so the journal shows all of them rather than only the first. */
export function evaluateEntryGate(input: EntryGateInput, ctx: EntryGateContext): EntryGateDecision {
  const reasons: string[] = [];
  if (ctx.stateError) reasons.push(`governor state unreadable: ${ctx.stateError}`);
  if (ctx.operatorHalted) reasons.push('operator halt (kill switch) is set');
  if (input.lastLiveTickAt <= 0) {
    reasons.push('no live trade tick received yet');
  } else if (input.now - input.lastLiveTickAt > ctx.maxTickAgeMs) {
    reasons.push(`last live tick ${Math.round((input.now - input.lastLiveTickAt) / 1000)}s ago (max ${Math.round(ctx.maxTickAgeMs / 1000)}s)`);
  }
  if (input.equity === null || !(input.equity > 0)) reasons.push('no account equity observed yet');

  let circuit: CircuitState = 'NORMAL';
  const state = ctx.state;
  if (state && input.equity !== null && input.equity > 0) {
    const dailyLossPct = state.dayStartEquity > 0 ? (Math.max(0, -state.dayRealizedPnl) / state.dayStartEquity) * 100 : 0;
    const drawdownPct = state.hwm > 0 ? (Math.max(0, state.hwm - input.equity) / state.hwm) * 100 : 0;
    circuit = deriveCircuitState(dailyLossPct, drawdownPct, state.lossStreak, ctx.limits);
    if (circuit === 'HALTED' || circuit === 'EMERGENCY') {
      reasons.push(
        `circuit ${circuit}: daily loss ${dailyLossPct.toFixed(2)}% (max ${ctx.limits.maxDailyLossPercent}%), `
        + `loss streak ${state.lossStreak} (max ${ctx.limits.maxLossStreak}), `
        + `drawdown ${drawdownPct.toFixed(2)}% (max ${ctx.limits.maxDrawdownPercent}%)`,
      );
    }
  }

  if (reasons.length > 0) return { allowed: false, riskMultiplier: 0, circuit, reasons };
  return { allowed: true, riskMultiplier: circuitRiskMultiplier(circuit), circuit, reasons: [`all gates passed (circuit ${circuit})`] };
}

export interface FleetEntryGateOptions {
  symbol: string;
  limits: RiskLimits;
  /** One file per symbol. A shared file would let two workers overwrite each other's state. */
  file: string;
  maxTickAgeMs?: number;
  /** Read at every decision, so an operator's halt takes effect on the next entry without a restart. */
  operatorHalted?: () => boolean;
}

/** The file-backed gate. A state file that cannot be read is never overwritten: rewriting it would reset the high-water mark and the streak. */
export class FleetEntryGate implements EntryGate {
  private state: GovernorSymbolState | undefined;
  private readonly stateError: string | undefined;
  private readonly maxTickAgeMs: number;
  private readonly operatorHalted: () => boolean;

  constructor(private readonly options: FleetEntryGateOptions) {
    const loaded = loadSymbolState(options.file);
    this.state = loaded.state;
    this.stateError = loaded.error;
    this.maxTickAgeMs = options.maxTickAgeMs ?? MAX_LIVE_TICK_AGE_MS;
    this.operatorHalted = options.operatorHalted ?? (() => new KillSwitch().isHalted());
  }

  decide(input: EntryGateInput): EntryGateDecision {
    return evaluateEntryGate(input, {
      operatorHalted: this.operatorHalted(),
      maxTickAgeMs: this.maxTickAgeMs,
      limits: this.options.limits,
      state: this.state,
      ...(this.stateError ? { stateError: this.stateError } : {}),
    });
  }

  observeEquity(equity: number, now: number): void {
    if (!(equity > 0) || this.stateError) return;
    const prev = this.state;
    const next = observeEquityState(prev, equity, now);
    this.state = next;
    if (!prev || prev.dayKey !== next.dayKey || prev.hwm !== next.hwm) this.persist();
  }

  recordExit(pnl: number, now: number): void {
    if (!this.state || this.stateError) {
      console.error(`[EntryGate ${this.options.symbol}] exit PnL ${pnl.toFixed(2)} not recorded: governor state is missing or unreadable`);
      return;
    }
    this.state = recordExitState(this.state, pnl, now);
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.options.file), { recursive: true });
      const tmp = `${this.options.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.options.file);
    } catch (err) {
      console.error(`[EntryGate ${this.options.symbol}] could not persist governor state: ${(err as Error).message}`);
    }
  }
}

function loadSymbolState(file: string): { state?: GovernorSymbolState; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { error: `cannot read ${file}: ${(err as Error).message}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isGovernorState(parsed) ? { state: parsed } : { error: `malformed ${file}` };
  } catch {
    return { error: `malformed ${file}` };
  }
}

function isGovernorState(value: unknown): value is GovernorSymbolState {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  const numbers = ['hwm', 'lastEquity', 'dayStartEquity', 'dayRealizedPnl', 'lossStreak'];
  return numbers.every((key) => typeof s[key] === 'number' && Number.isFinite(s[key] as number))
    && typeof s.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.dayKey);
}

/** The gate a fleet worker uses unless a caller injects one: the repo's risk limits, the operator kill switch, per-symbol state on disk. */
export function createFleetEntryGate(symbol: string): EntryGate {
  return new FleetEntryGate({
    symbol,
    limits: riskLimitsFromConfig(),
    file: path.resolve('data/fleet-governor', `${symbol.toLowerCase()}.json`),
  });
}
