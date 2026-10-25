import { OrderRejectedError, PaperExchangeClient, type PaperExchangeClientOptions } from '../binance/paperExchangeClient.js';
import { parseOptionSymbol } from './contract.js';
import { optionFee, walkBook, type FeeModel } from './execution.js';
import type { BookLevel, OptionContract } from './types.js';

export interface OptionOrderRequest {
  contract: OptionContract;
  qty: number;
  /** Worst acceptable price: a buy never pays above it, a sell never receives below it. */
  limitPrice: number;
  /** The opposite side of the book, best first (asks for a buy, bids for a sell), received just before the order. */
  book: ReadonlyArray<BookLevel>;
  indexPrice: number;
  /** Idempotency key: resubmitting the same id never fills twice. */
  clientOrderId: string;
}

export type OptionOrderStatus = 'FILLED' | 'PARTIALLY_FILLED' | 'UNFILLED' | 'REJECTED';

export interface OptionOrderResult {
  clientOrderId: string;
  status: OptionOrderStatus;
  filledQty: number;
  avgPrice: number;
  fee: number;
  reason?: string;
}

export interface VenueOptionPosition {
  symbol: string;
  qty: number;
  avgPrice: number;
}

/**
 * Where long option positions are held. A venue only ever buys to open and sells to close; there is no method that
 * could write an option. A venue with `canExecute: false` is a monitor: the engine reports what it would do.
 */
export interface OptionsVenue {
  readonly name: string;
  readonly canExecute: boolean;
  /** Account equity in USDT, marked to the last published marks. */
  equity(): Promise<number>;
  positions(): Promise<VenueOptionPosition[]>;
  buyToOpen(req: OptionOrderRequest): Promise<OptionOrderResult>;
  sellToClose(req: OptionOrderRequest): Promise<OptionOrderResult>;
  /** Outcome of an earlier submission whose reply was lost; null when the venue never saw it. */
  findOrder(clientOrderId: string): Promise<OptionOrderResult | null>;
  /** Option premiums and underlying index prices, keyed by symbol. */
  publishMarks(marks: Record<string, number>): Promise<void>;
}

/** A venue whose book lives in this process and must ride along in the engine's state file to survive a restart. */
export interface PersistentVenue {
  exportState(): LocalVenueState;
  importState(state: LocalVenueState): void;
}

export interface LocalVenueState {
  cash: number;
  held: Array<[string, { qty: number; avgPrice: number }]>;
  marks: Array<[string, number]>;
  orders: Array<[string, OptionOrderResult]>;
}

export const isPersistentVenue = (venue: OptionsVenue): venue is OptionsVenue & PersistentVenue =>
  typeof (venue as Partial<PersistentVenue>).exportState === 'function' && typeof (venue as Partial<PersistentVenue>).importState === 'function';

const MAX_REMEMBERED_ORDERS = 500;

const statusFor = (filled: number, wanted: number): OptionOrderStatus =>
  filled <= 0 ? 'UNFILLED' : filled + 1e-12 < wanted ? 'PARTIALLY_FILLED' : 'FILLED';

/**
 * In-process paper venue. Fills by walking the real book passed in with the order (VWAP, never past the limit,
 * lot-floored), so thin books produce real partial fills. Charges the same fee formula paper_exchange charges.
 * Cash accounting is exact: a buy debits premium + fee, a sell credits proceeds - fee.
 */
export class LocalOptionsPaperVenue implements OptionsVenue, PersistentVenue {
  readonly name = 'local-paper';
  readonly canExecute = true;
  private cash: number;
  private readonly held = new Map<string, { qty: number; avgPrice: number }>();
  private readonly marks = new Map<string, number>();
  private readonly orders = new Map<string, OptionOrderResult>();

  constructor(startingCash: number, private readonly fees: FeeModel) {
    if (!(startingCash > 0)) throw new Error('local paper venue needs positive starting cash');
    this.cash = startingCash;
  }

  async equity(): Promise<number> {
    let value = this.cash;
    for (const [symbol, pos] of this.held) value += pos.qty * (this.marks.get(symbol) ?? pos.avgPrice);
    return value;
  }

  async positions(): Promise<VenueOptionPosition[]> {
    return [...this.held].filter(([, p]) => p.qty > 0).map(([symbol, p]) => ({ symbol, qty: p.qty, avgPrice: p.avgPrice }));
  }

  async buyToOpen(req: OptionOrderRequest): Promise<OptionOrderResult> {
    const replay = this.orders.get(req.clientOrderId);
    if (replay) return replay;
    const fill = walkBook(req.book, 'buy', req.qty, req.limitPrice, req.contract);
    let result: OptionOrderResult;
    if (fill.qty <= 0) {
      result = { clientOrderId: req.clientOrderId, status: 'UNFILLED', filledQty: 0, avgPrice: 0, fee: 0, reason: 'no ask within limit' };
    } else {
      const fee = optionFee(this.fees, fill.avgPrice, fill.qty, req.indexPrice, req.contract.unit);
      const cost = fill.qty * fill.avgPrice + fee;
      if (cost > this.cash) {
        result = { clientOrderId: req.clientOrderId, status: 'REJECTED', filledQty: 0, avgPrice: 0, fee: 0, reason: `insufficient cash: needs ${cost.toFixed(2)}, has ${this.cash.toFixed(2)}` };
      } else {
        this.cash -= cost;
        const prev = this.held.get(req.contract.symbol) ?? { qty: 0, avgPrice: 0 };
        const qty = prev.qty + fill.qty;
        this.held.set(req.contract.symbol, { qty, avgPrice: (prev.qty * prev.avgPrice + fill.qty * fill.avgPrice) / qty });
        result = { clientOrderId: req.clientOrderId, status: statusFor(fill.qty, req.qty), filledQty: fill.qty, avgPrice: fill.avgPrice, fee };
      }
    }
    this.orders.set(req.clientOrderId, result);
    return result;
  }

  async sellToClose(req: OptionOrderRequest): Promise<OptionOrderResult> {
    const replay = this.orders.get(req.clientOrderId);
    if (replay) return replay;
    const pos = this.held.get(req.contract.symbol);
    let result: OptionOrderResult;
    if (!pos || pos.qty <= 0) {
      result = { clientOrderId: req.clientOrderId, status: 'REJECTED', filledQty: 0, avgPrice: 0, fee: 0, reason: 'no position to close' };
    } else {
      const wanted = Math.min(req.qty, pos.qty);
      const fill = walkBook(req.book, 'sell', wanted, req.limitPrice, req.contract);
      if (fill.qty <= 0) {
        result = { clientOrderId: req.clientOrderId, status: 'UNFILLED', filledQty: 0, avgPrice: 0, fee: 0, reason: 'no bid within limit' };
      } else {
        const fee = optionFee(this.fees, fill.avgPrice, fill.qty, req.indexPrice, req.contract.unit);
        this.cash += fill.qty * fill.avgPrice - fee;
        const left = Number((pos.qty - fill.qty).toFixed(12));
        if (left > 0) this.held.set(req.contract.symbol, { qty: left, avgPrice: pos.avgPrice });
        else this.held.delete(req.contract.symbol);
        result = { clientOrderId: req.clientOrderId, status: statusFor(fill.qty, wanted), filledQty: fill.qty, avgPrice: fill.avgPrice, fee };
      }
    }
    this.orders.set(req.clientOrderId, result);
    return result;
  }

  async findOrder(clientOrderId: string): Promise<OptionOrderResult | null> {
    return this.orders.get(clientOrderId) ?? null;
  }

  async publishMarks(marks: Record<string, number>): Promise<void> {
    for (const [symbol, price] of Object.entries(marks)) if (price > 0) this.marks.set(symbol, price);
  }

  exportState(): LocalVenueState {
    return {
      cash: this.cash,
      held: [...this.held].map(([k, v]) => [k, { ...v }]),
      marks: [...this.marks],
      orders: [...this.orders].slice(-MAX_REMEMBERED_ORDERS),
    };
  }

  /** Throws on a malformed snapshot instead of starting with a guessed balance. */
  importState(state: LocalVenueState): void {
    const valid = state && Number.isFinite(state.cash) && Array.isArray(state.held) && Array.isArray(state.marks) && Array.isArray(state.orders)
      && state.held.every(([sym, p]) => typeof sym === 'string' && p && Number.isFinite(p.qty) && p.qty >= 0 && Number.isFinite(p.avgPrice));
    if (!valid) throw new Error('local paper venue snapshot is malformed');
    this.cash = state.cash;
    this.held.clear();
    for (const [sym, p] of state.held) if (p.qty > 0) this.held.set(sym, { ...p });
    this.marks.clear();
    for (const [sym, price] of state.marks) this.marks.set(sym, price);
    this.orders.clear();
    for (const [id, result] of state.orders) this.orders.set(id, result);
  }
}

type Raw = Record<string, unknown>;

/** paper_exchange's option endpoints. `GET /api/orders` is keyset-paginated ({ data, next_cursor }). */
export class PaperExchangeOptionsClient extends PaperExchangeClient {
  async submitOptionOrder(params: {
    contract: OptionContract;
    side: 'buy' | 'sell';
    qty: number;
    executionPrice: number;
    clientOrderId: string;
  }): Promise<Raw> {
    const parsed = parseOptionSymbol(params.contract.symbol);
    if (!parsed) throw new Error(`not an option symbol: ${params.contract.symbol}`);
    return this.request<Raw>('POST', '/api/orders', {
      order: {
        symbol: params.contract.symbol,
        side: params.side,
        quantity: params.qty,
        order_type: 'market',
        instrument_type: 'CRYPTO_OPTION',
        option_type: parsed.right,
        strike_price: parsed.strike,
        expiry_date: parsed.expiryDate,
        leverage: 1,
        execution_price: params.executionPrice,
        client_order_id: params.clientOrderId,
        ...(params.side === 'sell' ? { reduce_only: true } : {}),
      },
    });
  }

  async optionPositions(): Promise<VenueOptionPosition[]> {
    const rows = await this.request<Raw[]>('GET', '/api/positions');
    return rows
      .filter((p) => (p.instrument_type === undefined || p.instrument_type === 'CRYPTO_OPTION') && parseOptionSymbol(String(p.symbol)) !== null)
      .filter((p) => p.side === 'long' && Number(p.net_quantity ?? p.quantity) > 0)
      .map((p) => ({ symbol: String(p.symbol), qty: Number(p.net_quantity ?? p.quantity), avgPrice: Number(p.average_price ?? p.entry_price) }));
  }

  /** Walks up to `maxPages` pages of recent orders for one client order id. */
  async findOptionOrder(clientOrderId: string, maxPages = 5): Promise<Raw | null> {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const path: string = cursor ? `/api/orders?limit=500&cursor=${encodeURIComponent(cursor)}` : '/api/orders?limit=500';
      const reply: Raw[] | { data: Raw[]; next_cursor: string | null } = await this.request('GET', path);
      const rows: Raw[] = Array.isArray(reply) ? reply : reply.data;
      const match = rows.find((o: Raw) => o.client_order_id === clientOrderId);
      if (match) return match;
      cursor = Array.isArray(reply) ? null : reply.next_cursor;
      if (!cursor) return null;
    }
    return null;
  }
}

/**
 * paper_exchange as the option venue. The broker has no option book, so this side walks the live Binance book it was
 * handed and sends the walked quantity at its VWAP as `execution_price`: both paper venues fill identically.
 * Transport failures surface as VenueUnavailableError (outcome unknown; the engine reconciles by client order id).
 */
export class PaperExchangeOptionsVenue implements OptionsVenue {
  readonly name = 'paper_exchange';
  readonly canExecute = true;
  private readonly client: PaperExchangeOptionsClient;

  constructor(baseUrl: string, accountId: string, private readonly fees: FeeModel, opts: PaperExchangeClientOptions = {}) {
    this.client = new PaperExchangeOptionsClient(baseUrl, accountId, opts);
  }

  /** Ensures a USD/USDT account exists; paper_exchange refuses USDT options on any other currency. */
  async ensureAccount(startingMargin: number): Promise<void> {
    let account = await this.client.getAccount();
    if (!account) {
      await this.client.createAccount(startingMargin);
      account = await this.client.getAccount();
    }
    if (!account) throw new Error('paper_exchange account could not be created');
    if (account.currency !== 'USDT' && account.currency !== 'USD') {
      throw new Error(`paper_exchange account currency is ${account.currency}; CRYPTO_OPTION needs USDT or USD`);
    }
  }

  async equity(): Promise<number> {
    const account = await this.client.getAccount();
    if (!account) throw new Error('paper_exchange account not found');
    return account.equity;
  }

  positions(): Promise<VenueOptionPosition[]> {
    return this.client.optionPositions();
  }

  buyToOpen(req: OptionOrderRequest): Promise<OptionOrderResult> {
    return this.submit(req, 'buy');
  }

  sellToClose(req: OptionOrderRequest): Promise<OptionOrderResult> {
    return this.submit(req, 'sell');
  }

  async findOrder(clientOrderId: string): Promise<OptionOrderResult | null> {
    const raw = await this.client.findOptionOrder(clientOrderId);
    return raw ? this.toResult(clientOrderId, raw, Number(raw.quantity)) : null;
  }

  async publishMarks(marks: Record<string, number>): Promise<void> {
    const valid = Object.fromEntries(Object.entries(marks).filter(([, p]) => Number.isFinite(p) && p > 0));
    if (Object.keys(valid).length > 0) await this.client.pushMarkPrices(valid);
  }

  private async submit(req: OptionOrderRequest, side: 'buy' | 'sell'): Promise<OptionOrderResult> {
    const fill = walkBook(req.book, side, req.qty, req.limitPrice, req.contract);
    if (fill.qty <= 0) return { clientOrderId: req.clientOrderId, status: 'UNFILLED', filledQty: 0, avgPrice: 0, fee: 0, reason: `no ${side === 'buy' ? 'ask' : 'bid'} within limit` };
    try {
      const raw = await this.client.submitOptionOrder({ contract: req.contract, side, qty: fill.qty, executionPrice: fill.avgPrice, clientOrderId: req.clientOrderId });
      const result = this.toResult(req.clientOrderId, raw, fill.qty, fill.avgPrice);
      if (result.status === 'FILLED' && fill.partial) result.status = 'PARTIALLY_FILLED';
      if (result.filledQty > 0) result.fee = optionFee(this.fees, result.avgPrice, result.filledQty, req.indexPrice, req.contract.unit);
      return result;
    } catch (err) {
      if (err instanceof OrderRejectedError) {
        return { clientOrderId: req.clientOrderId, status: 'REJECTED', filledQty: 0, avgPrice: 0, fee: 0, reason: err.message };
      }
      throw err;
    }
  }

  private toResult(clientOrderId: string, raw: Raw, requested: number, priceHint = 0): OptionOrderResult {
    const status = String(raw.status);
    const filled = Number(raw.filled_quantity ?? (status === 'filled' ? raw.quantity : 0));
    if (status === 'rejected' || status === 'cancelled' || status === 'expired') {
      return { clientOrderId, status: 'REJECTED', filledQty: 0, avgPrice: 0, fee: 0, reason: String(raw.rejection_reason ?? status) };
    }
    const filledQty = Number.isFinite(filled) ? filled : 0;
    // The order JSON carries no fill price; a market fill at execution_price fills exactly at the walked VWAP.
    return { clientOrderId, status: statusFor(filledQty, requested), filledQty, avgPrice: filledQty > 0 ? priceHint : 0, fee: 0 };
  }
}

/** CoinDCX monitor: signals and alerts only. coindcx-sdk 1.3.0 has no options endpoints, so nothing here can trade. */
export class MonitorOnlyVenue implements OptionsVenue {
  readonly canExecute = false;

  constructor(readonly name: string, private readonly notionalEquity: number) {}

  async equity(): Promise<number> {
    return this.notionalEquity;
  }

  async positions(): Promise<VenueOptionPosition[]> {
    return [];
  }

  async buyToOpen(): Promise<OptionOrderResult> {
    throw new Error(`${this.name} is monitor-only: it cannot place orders`);
  }

  async sellToClose(): Promise<OptionOrderResult> {
    throw new Error(`${this.name} is monitor-only: it cannot place orders`);
  }

  async findOrder(): Promise<OptionOrderResult | null> {
    return null;
  }

  async publishMarks(): Promise<void> {}
}
