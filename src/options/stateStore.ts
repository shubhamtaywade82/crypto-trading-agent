import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedLeg, OptionExitReason } from './ExitPolicy.js';
import type { OptionTradeState } from './OptionPositionMachine.js';
import type { RiskBookState } from './OptionRiskPlanner.js';
import type { OptionContract } from './types.js';
import type { LocalVenueState } from './venues.js';

/** An entry order whose id is on disk before it is sent, so a crash between send and reply is reconcilable. */
export interface PendingEntry {
  clientOrderId: string;
  contract: OptionContract;
  qty: number;
  limitPrice: number;
  stopPct: number;
  targetPct: number;
  submittedAt: number;
}

export interface OpenOptionPosition {
  contract: OptionContract;
  /** Contracts still held. */
  qty: number;
  entryPrice: number;
  entryFee: number;
  entryClientOrderId: string;
  leg: ManagedLeg;
  /** Set once an exit is triggered; the exit keeps its reason across retries and restarts. */
  exitReason?: OptionExitReason;
  exitAttempts: number;
  /** Id of an exit order whose outcome is unknown (transport failure); reused until resolved so it cannot fill twice. */
  unresolvedExitId?: string;
  /** Sum over exit fills of qty x price, and their fees, to compute the trade's realized PnL. */
  closedQty: number;
  exitProceeds: number;
  exitFees: number;
}

export interface UnderlyingSlot {
  state: OptionTradeState;
  updatedAt: number;
  cooldownUntil: number;
  pendingEntry?: PendingEntry;
  position?: OpenOptionPosition;
}

export interface OptionsState {
  version: 1;
  slots: Record<string, UnderlyingSlot>;
  riskBook: RiskBookState | null;
  /** Book of the in-process paper venue; absent for venues that keep their own state. */
  localVenue?: LocalVenueState;
}

export const emptySlot = (now: number): UnderlyingSlot => ({ state: 'IDLE', updatedAt: now, cooldownUntil: 0 });

/**
 * Engine state on disk, written atomically (tmp + rename). A missing file is a clean start. A file that exists but
 * cannot be read or parsed throws: it may describe an open position or an in-flight order, and starting from an
 * empty state would orphan both.
 */
export class OptionsStateStore {
  constructor(private readonly filePath: string) {}

  load(): OptionsState {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, slots: {}, riskBook: null };
      throw new Error(`options state ${this.filePath} unreadable: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`options state ${this.filePath} is not valid JSON; repair or move it before starting`);
    }
    const state = parsed as Partial<OptionsState>;
    if (state?.version !== 1 || typeof state.slots !== 'object' || state.slots === null) {
      throw new Error(`options state ${this.filePath} has an unknown shape; repair or move it before starting`);
    }
    return { version: 1, slots: state.slots, riskBook: state.riskBook ?? null, ...(state.localVenue ? { localVenue: state.localVenue } : {}) };
  }

  save(state: OptionsState): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.filePath);
  }
}

export interface JournalEvent {
  ts: number;
  underlying: string;
  event: string;
  [key: string]: unknown;
}

/** Append-only JSONL audit of every decision, order and fill. A failed append is reported, never thrown into the trading loop. */
export class OptionsJournal {
  lastError?: string;

  constructor(private readonly filePath: string | null) {}

  append(event: JournalEvent): void {
    if (!this.filePath) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }
}
