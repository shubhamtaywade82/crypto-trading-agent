import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentId, TradeRecord } from '../types.js';

/** One execution, as the venue's account trade list reports it. */
export interface FillView {
  /** The venue's trade id. Cursors advance on it, so it must increase with time. */
  readonly id: number;
  readonly symbol: string;
  readonly orderId: number;
  readonly side: 'BUY' | 'SELL';
  readonly price: number;
  readonly qty: number;
  /** Gross realized PnL of this execution in quote currency; zero for an execution that only opens or adds. */
  readonly realizedPnl: number;
  readonly commission: number;
  readonly commissionAsset: string;
  readonly time: number;
}

/** A funding-fee or other income line; a positive amount was received. */
export interface FundingView {
  readonly symbol: string;
  readonly amount: number;
  readonly time: number;
}

export interface JournalOwnerLookup {
  (symbol: string, closedAt: number): AgentId;
}

export interface JournalBuild {
  readonly trades: TradeRecord[];
  /** Commissions in an asset other than USDT. They are not converted, so these trades' PnL excludes them. */
  readonly unpricedFees: number;
}

/**
 * Closed trades from executions. A closing execution is one with realized PnL; the venue computes that PnL as
 * (exit − entry) × qty × direction, so the entry is recovered exactly as exit − direction × realized / qty. No history
 * before the first sync is needed.
 *
 * Executions of one order aggregate into one trade. Commissions on opening executions, and funding fees, are charged to
 * the next close of the same symbol, so the sum of PnL across the journal equals the account's realized result.
 *
 * Approximation: a reversing order (one that closes and opens in a single execution) is treated as entirely closing,
 * which the bot never sends.
 */
export function closedTradesFromFills(
  fills: readonly FillView[],
  funding: readonly FundingView[],
  ownerOf: JournalOwnerLookup,
  pending: Record<string, number> = {},
): JournalBuild & { pending: Record<string, number> } {
  const carry: Record<string, number> = { ...pending };
  const events = [
    ...fills.map((f) => ({ kind: 'fill' as const, at: f.time, symbol: f.symbol, fill: f })),
    ...funding.map((f) => ({ kind: 'funding' as const, at: f.time, symbol: f.symbol, amount: f.amount })),
  ].sort((a, b) => a.at - b.at);

  const trades: TradeRecord[] = [];
  let unpricedFees = 0;
  // Closing executions of one order, grouped until the order changes
  let group: { symbol: string; orderId: number; side: 'BUY' | 'SELL'; fills: FillView[] } | null = null;

  const finish = (): void => {
    if (!group) return;
    const { symbol, side, fills: closing } = group;
    group = null;
    const qty = closing.reduce((sum, f) => sum + f.qty, 0);
    const exit = closing.reduce((sum, f) => sum + f.price * f.qty, 0) / qty;
    const realized = closing.reduce((sum, f) => sum + f.realizedPnl, 0);
    const direction = side === 'SELL' ? 1 : -1; // a sell closes a long
    const entry = exit - (direction * realized) / qty;
    let fees = 0;
    for (const f of closing) {
      if (f.commissionAsset === 'USDT') fees += f.commission;
      else unpricedFees += f.commission;
    }
    const charges = carry[symbol] ?? 0;
    carry[symbol] = 0;
    const closedAt = Math.max(...closing.map((f) => f.time));
    trades.push({
      symbol,
      strategy: ownerOf(symbol, closedAt),
      side: direction === 1 ? 'LONG' : 'SHORT',
      entry,
      exit,
      qty,
      pnl: realized - fees + charges,
      reason: 'CLOSE',
      closedAt,
    });
  };

  for (const event of events) {
    // Funding and opening executions only add to the next close's charges; they never split a close in progress
    if (event.kind === 'funding') {
      carry[event.symbol] = (carry[event.symbol] ?? 0) + event.amount;
      continue;
    }
    const f = event.fill;
    if (f.realizedPnl === 0) {
      carry[f.symbol] = (carry[f.symbol] ?? 0) - (f.commissionAsset === 'USDT' ? f.commission : 0);
      unpricedFees += f.commissionAsset === 'USDT' ? 0 : f.commission;
      continue;
    }
    if (group && (group.orderId !== f.orderId || group.symbol !== f.symbol)) finish();
    if (!group) group = { symbol: f.symbol, orderId: f.orderId, side: f.side, fills: [] };
    group.fills.push(f);
  }
  finish();
  return { trades, unpricedFees, pending: carry };
}

interface JournalFile {
  readonly version: 1;
  readonly syncedAt: number;
  readonly cursors: Record<string, number>;
  readonly fundingSince: number;
  readonly pending: Record<string, number>;
  readonly trades: TradeRecord[];
}

const EMPTY: JournalFile = { version: 1, syncedAt: 0, cursors: {}, fundingSince: 0, pending: {}, trades: [] };
const KEEP_TRADES = 1_000;
const PAGE = 1_000;
const FUNDING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** What the journal reads from the venue. BinanceService implements it against USD-M; tests use a fake. */
export interface JournalSource {
  accountTrades(symbol: string, fromId: number | undefined, limit: number): Promise<FillView[]>;
  fundingFees(startTime: number, limit: number): Promise<FundingView[]>;
}

/**
 * The bot's own closed-trade journal for live mode. It is the input the daily-loss and loss-streak governors need, and
 * the venue does not keep one in a form they can read. It persists, so a restart resumes from the cursors.
 *
 * It fails closed: until a sync has succeeded, `isFresh` is false and the caller refuses entries.
 */
export class LiveJournal {
  private state: JournalFile = EMPTY;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.load();
  }

  /** Journal trades, oldest first. */
  trades(): TradeRecord[] {
    return [...this.state.trades];
  }

  /** True when a sync succeeded within `maxAgeMs`. */
  isFresh(maxAgeMs: number): boolean {
    return this.state.syncedAt > 0 && this.now() - this.state.syncedAt <= maxAgeMs;
  }

  get lastSyncedAt(): number {
    return this.state.syncedAt;
  }

  /**
   * Pulls executions for each symbol from its cursor, and funding fees since the last sync. Any failure throws and
   * leaves the journal as it was, so `isFresh` decays and entries stop.
   */
  async sync(source: JournalSource, symbols: readonly string[], ownerOf: JournalOwnerLookup): Promise<{ newTrades: number; unpricedFees: number }> {
    const cursors = { ...this.state.cursors };
    const fills: FillView[] = [];
    for (const symbol of symbols) {
      let fromId = cursors[symbol] === undefined ? undefined : cursors[symbol] + 1;
      for (;;) {
        const page = await source.accountTrades(symbol, fromId, PAGE);
        fills.push(...page);
        if (page.length > 0) cursors[symbol] = Math.max(cursors[symbol] ?? 0, ...page.map((f) => f.id));
        if (page.length < PAGE) break;
        fromId = Math.max(...page.map((f) => f.id)) + 1;
      }
    }
    const fundingSince = this.state.fundingSince > 0 ? this.state.fundingSince : this.now() - FUNDING_LOOKBACK_MS;
    const funding = await source.fundingFees(fundingSince, PAGE);
    const built = closedTradesFromFills(fills, funding, ownerOf, this.state.pending);
    const trades = [...this.state.trades, ...built.trades].slice(-KEEP_TRADES);
    this.state = {
      version: 1,
      syncedAt: this.now(),
      cursors,
      fundingSince: this.now(),
      pending: built.pending,
      trades,
    };
    this.save();
    return { newTrades: built.trades.length, unpricedFees: built.unpricedFees };
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as JournalFile;
      if (parsed?.version === 1 && Array.isArray(parsed.trades)) this.state = parsed;
    } catch {
      // Missing or unreadable: the journal is empty and not fresh until a sync succeeds
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}

/** Which strategy opened each symbol, and when: the owner of a close is the owner of the entry before it. */
export interface OwnerRecord {
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly strategy: AgentId;
  readonly submittedAt: number;
  readonly clientOrderId: string;
}

export class LiveOwners {
  private records: OwnerRecord[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { records?: OwnerRecord[] };
      if (Array.isArray(parsed?.records)) this.records = parsed.records;
    } catch {
      // No record yet: positions read as the executor's until an entry is recorded
    }
  }

  record(entry: OwnerRecord): void {
    this.records = [...this.records, entry].slice(-500);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ records: this.records }));
    renameSync(tmp, this.file);
  }

  /**
   * The strategy of the latest entry on `symbol` (and `side`, when given) submitted at or before `at`. The executor when
   * none is known: a position opened by hand, or in the other direction to every recorded entry, is not the strategy's.
   */
  ownerAt(symbol: string, at: number, side?: 'LONG' | 'SHORT'): AgentId {
    let owner: AgentId = 'EXECUTOR-ε';
    let latest = -Infinity;
    for (const r of this.records) {
      if (r.symbol === symbol && (side === undefined || r.side === side) && r.submittedAt <= at && r.submittedAt > latest) {
        owner = r.strategy;
        latest = r.submittedAt;
      }
    }
    return owner;
  }
}
