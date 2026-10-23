import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId, ExitReason, Position, Side, TradeRecord } from '../types.js';
import { formatPrice } from './symbolRules.js';
import { OwnershipError } from './remoteOrders.js';
import { directionOf, findStopExit } from './stopRules.js';
import { config } from '../config.js';

interface PaperPosition extends Position {
  orderId: string;
  /** Taker fee paid on the open portion, charged against the position's PnL as it closes. */
  openFee?: number;
  /** Funding accrued on the position so far; negative when paid, positive when received. */
  funding?: number;
  /** Epoch ms the position opened, quantity-weighted across scale-ins. Funding is charged only for boundaries after it. */
  openedAt?: number;
}

/** What a paper fill costs the way the live account pays it: a taker fee on notional, and slippage that works against the trader. */
export interface PaperCosts {
  takerFeeRate: number;
  slippageRate: number;
}

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

interface FillParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  leverage: number;
  strategy: AgentId;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
  /** Journal reason for a reduce-only fill; defaults to CLOSE. PARTIAL TP marks the record partial. */
  exitReason?: ExitReason;
  entryPrice?: number;
  /** DecisionRecord linkage: carried onto the position and into its trade journal entries. */
  decisionId?: string;
}

// A realistic retail bankroll (~₹1,00,000), not the unrealistic 100k USDT default
const INITIAL_EQUITY = 1_150;
const MAX_TRADES = 1000;

// Binance's lowest-tier maintenance margin rate; real tiers rise with notional
const MAINTENANCE_MARGIN_RATE = 0.005;

/** Isolated-margin liquidation price; null when a 1x long cannot be liquidated. */
function liquidationPrice(side: Side, entry: number, leverage: number): number | null {
  if (side === 'LONG' && leverage <= 1) return null;
  const buffer = 1 / leverage - MAINTENANCE_MARGIN_RATE;
  return side === 'LONG' ? entry * (1 - buffer) : entry * (1 + buffer);
}

/** Recomputes every mark-derived field from pos.mark, pos.entry and pos.qty. */
function refreshMetrics(pos: PaperPosition): void {
  const direction = directionOf(pos.side);
  const liqPrice = liquidationPrice(pos.side, pos.entry, pos.leverage);
  pos.upnl = (pos.mark - pos.entry) * pos.qty * direction - (pos.openFee ?? 0) + (pos.funding ?? 0);
  pos.upnlPct = pos.entry ? ((pos.mark - pos.entry) / pos.entry) * 100 * direction : 0;
  pos.liqDistancePct = liqPrice ? (Math.abs(pos.mark - liqPrice) / pos.mark) * 100 : null;
}

/** Price and reason at which the exchange would have closed the position, or null. */
function findExit(pos: PaperPosition): { price: number; reason: ExitReason } | null {
  const direction = directionOf(pos.side);
  const liqPrice = liquidationPrice(pos.side, pos.entry, pos.leverage);

  if (liqPrice !== null && (pos.mark - liqPrice) * direction <= 0) {
    return { price: liqPrice, reason: 'LIQUIDATED' };
  }
  const stopExit = findStopExit(pos);
  if (stopExit) {
    return stopExit;
  }
  return null;
}

export class PaperEngine {
  private positions: PaperPosition[] = [];
  private equity = INITIAL_EQUITY;
  // Wallet balance: starting cash plus realized PnL (name kept for saved-state compatibility)
  private startEquity = INITIAL_EQUITY;
  private trades: TradeRecord[] = [];
  private lastPrices: Record<string, number> = {};
  private saveTimer: NodeJS.Timeout | null = null;

  /** Boundary index of the last funding accrual; -1 until the clock is set by the first call. */
  private fundingSlot = -1;

  constructor(
    private readonly filePath = path.resolve('data/paper-state.json'),
    private readonly costs: PaperCosts = { takerFeeRate: config.risk.takerFeeRate, slippageRate: config.risk.slippageBufferRate },
    private readonly now: () => number = Date.now,
  ) {
    this.loadState();
  }

  /** The price a fill gets: slippage moves it against the trader, on entries and on exits alike. */
  private fillPrice(side: Side, price: number, opening: boolean): number {
    const against = opening ? directionOf(side) : -directionOf(side);
    return price * (1 + against * this.costs.slippageRate);
  }

  /**
   * Charges funding at each 8-hour (UTC) boundary a position was open through: a long pays a positive rate and a short
   * receives it, on the position's mark notional. A boundary at or before the position's open time is not charged to it.
   * The first call only sets the clock. The clock is saved with the book, so a boundary crossed while the process was down
   * is charged on the next call. Several boundaries crossed at once each use the current rate, an approximation.
   */
  accrueFunding(rates: Record<string, number>, now = this.now()): void {
    const slot = Math.floor(now / FUNDING_INTERVAL_MS);
    if (this.fundingSlot < 0) {
      this.fundingSlot = slot;
      return;
    }
    if (slot <= this.fundingSlot) return;
    for (const pos of this.positions) {
      const rate = rates[pos.symbol];
      if (!Number.isFinite(rate)) continue;
      const openedSlot = pos.openedAt === undefined ? -1 : Math.floor(pos.openedAt / FUNDING_INTERVAL_MS);
      const first = Math.max(this.fundingSlot, openedSlot) + 1;
      const crossed = slot - first + 1;
      if (crossed <= 0) continue;
      pos.funding = (pos.funding ?? 0) - directionOf(pos.side) * rate * pos.qty * pos.mark * crossed;
      refreshMetrics(pos);
    }
    this.fundingSlot = slot;
    this.syncEquity();
    this.persist();
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.positions) && typeof data.equity === 'number') {
        this.positions = data.positions;
        this.equity = data.equity;
        this.startEquity = data.startEquity ?? data.equity;
        this.trades = Array.isArray(data.closedTrades) ? data.closedTrades : [];
        this.fundingSlot = Number.isInteger(data.fundingSlot) ? data.fundingSlot : -1;
      }
    } catch {
      // Best-effort load; fall back to an empty book on parse error
    }
  }

  private persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        const payload = JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          equity: this.equity,
          startEquity: this.startEquity,
          fundingSlot: this.fundingSlot,
          positions: this.positions,
          closedTrades: this.trades,
        }, null, 2);
        fs.writeFileSync(tmp, payload, 'utf-8');
        fs.renameSync(tmp, this.filePath);
      } catch {
        // Disk write failures should never interrupt active trading
      }
    }, 250);
  }

  getAccount() {
    const marginUsed = this.positions.reduce(
      (sum, pos) => sum + (pos.qty * pos.mark) / (pos.leverage || 1),
      0
    );
    return { equity: this.equity, marginUsed, initialEquity: INITIAL_EQUITY };
  }

  /** Realized closes, oldest first. */
  getTrades(): TradeRecord[] {
    return [...this.trades];
  }

  getPositions(): Position[] {
    return [...this.positions];
  }

  /** Fills at market: opens, scales into, or flips the symbol+strategy position; reduceOnly only shrinks it. */
  openPosition(params: FillParams): { orderId: number; status: string } {
    const existing = this.positions.find(
      (p) => p.symbol === params.symbol && p.strategy === params.strategy
    );
    const price = params.entryPrice || this.lastPrices[params.symbol] || existing?.mark;
    if (!price) throw new Error(`Paper fill rejected for ${params.symbol}: no price available`);

    const side: Side = params.side === 'BUY' ? 'LONG' : 'SHORT';
    if (!params.reduceOnly) this.assertSymbolNotHeldByOther(params);
    if (params.reduceOnly) {
      if (existing) this.reduce(existing, params.qty, price, params.exitReason ?? 'CLOSE');
    } else if (!existing) {
      this.positions.push(this.createPosition(params, side, this.fillPrice(side, price, true), params.qty));
    } else if (existing.side === side) {
      this.scaleIn(existing, params, this.fillPrice(side, price, true));
    } else {
      // An opposite entry is a full reversal: netting by qty could silently drop the new side when it is the smaller order
      this.reduce(existing, existing.qty, price, 'FLIP');
      this.positions.push(this.createPosition(params, side, this.fillPrice(side, price, true), params.qty));
    }
    this.syncEquity();
    this.persist();
    return { orderId: Date.now(), status: 'FILLED' };
  }

  /** One strategy per symbol, the same rule the remote broker enforces (real exchanges net a symbol into one position). */
  private assertSymbolNotHeldByOther(params: FillParams): void {
    const holder = this.positions.find((p) => p.symbol === params.symbol && p.strategy !== params.strategy);
    if (holder) throw new OwnershipError(`${params.symbol} is held by ${holder.strategy}; ${params.strategy} may not trade it`);
  }

  /**
   * Books realized PnL on up to qty of pos and journals it; returns the unfilled remainder. The closed portion carries its
   * share of the open fee and of the funding, and pays the exit fee, so the journal's PnL is the account's net result.
   */
  private reduce(pos: PaperPosition, qty: number, rawPrice: number, reason: ExitReason): number {
    const closeQty = Math.min(pos.qty, qty);
    const share = pos.qty > 0 ? closeQty / pos.qty : 0;
    const price = this.fillPrice(pos.side, rawPrice, false);
    const openFee = (pos.openFee ?? 0) * share;
    const funding = (pos.funding ?? 0) * share;
    const exitFee = price * closeQty * this.costs.takerFeeRate;
    const gross = (price - pos.entry) * closeQty * directionOf(pos.side);
    const pnl = gross - openFee - exitFee + funding;
    this.startEquity += pnl;
    pos.openFee = (pos.openFee ?? 0) - openFee;
    pos.funding = (pos.funding ?? 0) - funding;
    this.trades.push({
      symbol: pos.symbol, strategy: pos.strategy, side: pos.side, entry: pos.entry,
      exit: price, qty: closeQty, pnl, reason, closedAt: Date.now(),
      ...(pos.initialRisk === undefined ? {} : { initialRisk: pos.initialRisk }),
      ...(pos.decisionId === undefined ? {} : { decisionId: pos.decisionId }),
      ...(reason === 'PARTIAL TP' ? { partial: true } : {}),
    });
    if (this.trades.length > MAX_TRADES) this.trades.shift();
    pos.qty -= closeQty;
    if (pos.qty <= 0) this.positions.splice(this.positions.indexOf(pos), 1);
    else refreshMetrics(pos); // a partial leaves a smaller position: its unrealized PnL must follow the remaining quantity
    return qty - closeQty;
  }

  private scaleIn(pos: PaperPosition, params: FillParams, price: number): void {
    const totalQty = pos.qty + params.qty;
    pos.entry = (pos.entry * pos.qty + price * params.qty) / totalQty;
    pos.openFee = (pos.openFee ?? 0) + price * params.qty * this.costs.takerFeeRate;
    pos.openedAt = ((pos.openedAt ?? this.now()) * pos.qty + this.now() * params.qty) / totalQty;
    pos.qty = totalQty;
    pos.mark = price;
    pos.leverage = params.leverage;
    // One SL/TP per position: the newest signal's levels replace the old ones
    if (params.stopLoss) pos.serverSl = String(params.stopLoss);
    if (params.takeProfit) pos.serverTp = String(params.takeProfit);
    refreshMetrics(pos);
  }

  private createPosition(params: FillParams, side: Side, price: number, qty: number): PaperPosition {
    const pos: PaperPosition = {
      id: `${params.symbol}_${params.strategy}`,
      orderId: String(Date.now()),
      symbol: params.symbol,
      side,
      strategy: params.strategy,
      entry: price,
      qty,
      mark: price,
      openFee: price * qty * this.costs.takerFeeRate,
      openedAt: this.now(),
      initialRisk: params.stopLoss ? Math.abs(price - params.stopLoss) : undefined,
      upnl: 0,
      upnlPct: 0,
      leverage: params.leverage,
      marginType: 'ISOLATED',
      liqDistancePct: null,
      serverSl: params.stopLoss ? String(params.stopLoss) : '—',
      serverTp: params.takeProfit ? String(params.takeProfit) : 'trail',
      ...(params.decisionId === undefined ? {} : { decisionId: params.decisionId }),
    };
    refreshMetrics(pos);
    return pos;
  }

  /** Replaces SL/TP on the symbol+strategy position; the next markAll triggers on them. */
  updateStops(symbol: string, strategy: AgentId, stopLoss: number, takeProfit: number | null): void {
    const pos = this.positions.find((p) => p.symbol === symbol && p.strategy === strategy);
    if (!pos) return;
    pos.serverSl = String(stopLoss);
    pos.serverTp = takeProfit === null ? 'trail' : String(takeProfit);
    this.persist();
  }

  /** Removes saved positions whose symbol is not tradable; they never had a price, so no PnL is booked. */
  dropUnlistedSymbols(symbols: string[]): string[] {
    const dropped = this.positions.filter((p) => !symbols.includes(p.symbol)).map((p) => p.symbol);
    if (dropped.length === 0) return dropped;
    this.positions = this.positions.filter((p) => symbols.includes(p.symbol));
    this.syncEquity();
    this.persist();
    return dropped;
  }

  private syncEquity(): void {
    this.equity = this.startEquity + this.positions.reduce((sum, pos) => sum + pos.upnl, 0);
  }

  /** Marks positions to market and closes any that hit liquidation, SL or TP; returns log lines for those exits. */
  markAll(prices: Record<string, number>): string[] {
    Object.assign(this.lastPrices, prices);
    const exits: string[] = [];

    for (const pos of [...this.positions]) {
      const mark = prices[pos.symbol];
      if (!mark) continue;
      pos.mark = mark;
      const exit = findExit(pos);
      if (!exit) {
        refreshMetrics(pos);
        continue;
      }
      const before = this.startEquity;
      this.reduce(pos, pos.qty, exit.price, exit.reason);
      const pnl = this.startEquity - before;
      exits.push(`${exit.reason} ${pos.symbol} ${pos.side} @ ${formatPrice(pos.symbol, exit.price)} pnl=${pnl.toFixed(2)}`);
    }
    this.syncEquity();
    this.persist();
    return exits;
  }

  /**
   * Synchronous flush — writes the current state to disk immediately. The
   * default `persist()` is debounced by 250ms so a tight loop of fills
   * doesn't write on every tick; on shutdown, that debounce can drop the
   * last state if SIGTERM arrives in the 250ms window. Issue #5: callers
   * should invoke this from a SIGINT/SIGTERM hook.
   */
  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const payload = JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        equity: this.equity,
        startEquity: this.startEquity,
        positions: this.positions,
        closedTrades: this.trades,
      }, null, 2);
      fs.writeFileSync(tmp, payload, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Disk write failures should never interrupt shutdown
    }
  }
}
