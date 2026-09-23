import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentId } from '../types.js';

export interface AgentStats {
  trades: number;
  wins: number;
  totalR: number; // sum of realized R-multiples
}

export type AgentLedgerData = Partial<Record<AgentId, AgentStats>>;

const EMPTY: AgentStats = { trades: 0, wins: 0, totalR: 0 };
const MAX_HISTORY = 50; // rolling window: only last N trades affect stats

/** On-disk per-agent stats. Sync I/O is intentional — written once per exit, not in hot path. */
export class AgentLedger {
  private data: AgentLedgerData = {};

  constructor(private readonly path: string) {
    this.load();
  }

  get(id: AgentId): AgentStats {
    return this.data[id] ?? { ...EMPTY };
  }

  record(id: AgentId, win: boolean, rMultiple: number): void {
    const prev = this.data[id] ?? { ...EMPTY };
    // Rolling window: once trade count exceeds MAX_HISTORY, decay older results
    const weight = Math.min(prev.trades, MAX_HISTORY - 1);
    const newTrades = weight + 1;
    const newWins = win ? prev.wins * (weight / newTrades) + 1 : prev.wins * (weight / newTrades);
    const newR = (prev.totalR * weight + rMultiple) / newTrades;
    this.data[id] = { trades: newTrades, wins: newWins, totalR: newR };
    this.save();
  }

  /** Win-rate 0–1, or null if fewer than 3 trades (cold start). */
  winRate(id: AgentId): number | null {
    const s = this.data[id];
    if (!s || s.trades < 3) return null;
    return s.wins / s.trades;
  }

  /** Average R-multiple, or null during cold start. */
  avgR(id: AgentId): number | null {
    const s = this.data[id];
    if (!s || s.trades < 3) return null;
    return s.totalR / s.trades;
  }

  private load(): void {
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf-8')) as AgentLedgerData;
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch {
      // Non-fatal: learning state is best-effort, never blocks trading
    }
  }
}
