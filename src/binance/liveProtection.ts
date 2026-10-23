import { randomBytes } from 'node:crypto';

/** Entry orders carry this prefix (see liveEntryClientOrderId); it is how a restart recognises the bot's own resting entries. */
export const ENTRY_ORDER_PREFIX = 'e';
/** Protective orders carry this prefix so a retried placement can be found by its client id before it is sent again. */
export const PROTECTION_ORDER_PREFIX = 'p';

/** Binance caps newClientOrderId at 36 characters: prefix + base36 time + 12 hex digits is 21. */
export function protectionClientOrderId(nowMs: number): string {
  return `${PROTECTION_ORDER_PREFIX}${nowMs.toString(36)}${randomBytes(6).toString('hex')}`;
}

/** The fields of a venue open order this code reads. */
export interface OpenOrderView {
  readonly symbol: string;
  readonly orderId: number;
  readonly clientOrderId: string;
  readonly type: string;
  readonly side: 'BUY' | 'SELL';
  readonly reduceOnly: boolean;
  readonly closePosition: boolean;
  readonly stopPrice: number;
  readonly status: string;
}

/** A position as the venue reports it: positive amount is long, negative is short, zero is flat. */
export interface VenuePositionView {
  readonly symbol: string;
  readonly amount: number;
}

export const isEntryOrder = (o: OpenOrderView): boolean =>
  o.type === 'LIMIT' && !o.reduceOnly && !o.closePosition && o.clientOrderId.startsWith(ENTRY_ORDER_PREFIX);

export const isProtectiveOrder = (o: OpenOrderView): boolean =>
  (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET') && o.closePosition;

/** The side that closes a position of this sign: a long is closed by a sell. */
export const exitSideOf = (amount: number): 'BUY' | 'SELL' => (amount > 0 ? 'SELL' : 'BUY');

export interface PositionProtection {
  /** The tightest stop on the exit side: highest for a long, lowest for a short. Null when none rests. */
  readonly stopPrice: number | null;
  readonly takeProfitPrice: number | null;
  readonly stopOrderIds: readonly number[];
  readonly takeProfitOrderIds: readonly number[];
}

/** Stops and targets that protect `symbol`'s position, read from its open orders. A stop left over from a replacement is tolerated. */
export function protectionOf(orders: readonly OpenOrderView[], symbol: string, amount: number): PositionProtection {
  const exit = exitSideOf(amount);
  const mine = orders.filter((o) => o.symbol === symbol && o.side === exit && isProtectiveOrder(o));
  const stops = mine.filter((o) => o.type === 'STOP_MARKET');
  const targets = mine.filter((o) => o.type === 'TAKE_PROFIT_MARKET');
  const tightest = amount > 0 ? Math.max : Math.min;
  return {
    stopPrice: stops.length === 0 ? null : tightest(...stops.map((o) => o.stopPrice)),
    takeProfitPrice: targets.length === 0 ? null : targets[0].stopPrice,
    stopOrderIds: stops.map((o) => o.orderId),
    takeProfitOrderIds: targets.map((o) => o.orderId),
  };
}

export interface StartupReconciliation {
  /** Orders the bot must cancel: its own resting entries, and protective orders on symbols that are flat. */
  readonly cancel: readonly OpenOrderView[];
  /** Symbols holding a position with no protective stop on the venue. Their entries stay blocked. */
  readonly unprotected: readonly string[];
  /** Resting orders the bot does not recognise. Reported, not touched: they may be the operator's. */
  readonly unrecognised: readonly OpenOrderView[];
}

/** What to do with the venue's open orders and positions when the bot starts. Pure: the caller performs the cancels. */
export function planStartupReconciliation(orders: readonly OpenOrderView[], positions: readonly VenuePositionView[]): StartupReconciliation {
  const held = new Map(positions.filter((p) => p.amount !== 0).map((p) => [p.symbol, p.amount] as const));
  const cancel: OpenOrderView[] = [];
  const unrecognised: OpenOrderView[] = [];
  for (const order of orders) {
    if (isEntryOrder(order)) cancel.push(order);
    else if (isProtectiveOrder(order) && !held.has(order.symbol)) cancel.push(order);
    else if (!isProtectiveOrder(order)) unrecognised.push(order);
  }
  const unprotected = [...held.keys()].filter((symbol) => {
    const amount = held.get(symbol)!;
    return protectionOf(orders, symbol, amount).stopOrderIds.length === 0;
  });
  return { cancel, unprotected, unrecognised };
}

/** Binance answers an isolated-margin request on a symbol that is already isolated with code -4046. Nothing else may be ignored. */
export const isAlreadyIsolated = (err: unknown): boolean => {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code === -4046 || /No need to change margin type/i.test(message);
};

/** The venue answered with an error code, so the request was refused and certainly did not rest. A timeout or dropped connection carries no code and proves nothing. */
export const isVenueRejection = (err: unknown): boolean => typeof (err as { code?: unknown })?.code === 'number';

/** A fill or order update from the user data stream, reduced to the fields the entry tracker and the journal use. */
export interface OrderUpdateView {
  readonly symbol: string;
  readonly clientOrderId: string;
  readonly side: 'BUY' | 'SELL';
  readonly orderType: string;
  readonly executionType: string;
  readonly status: string;
  readonly reduceOnly: boolean;
  readonly lastFilledQty: number;
  readonly cumulativeFilledQty: number;
  readonly averagePrice: number;
  readonly realizedPnl: number;
}

/** Parses an ORDER_TRADE_UPDATE event (Binance USD-M user data stream). Returns null for anything else. */
export function parseOrderTradeUpdate(event: unknown): OrderUpdateView | null {
  const e = event as { e?: unknown; o?: Record<string, unknown> } | null;
  if (!e || e.e !== 'ORDER_TRADE_UPDATE' || !e.o || typeof e.o !== 'object') return null;
  const o = e.o;
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    symbol: String(o.s ?? ''),
    clientOrderId: String(o.c ?? ''),
    side: o.S === 'SELL' ? 'SELL' : 'BUY',
    orderType: String(o.o ?? ''),
    executionType: String(o.x ?? ''),
    status: String(o.X ?? ''),
    reduceOnly: o.R === true,
    lastFilledQty: num(o.l),
    cumulativeFilledQty: num(o.z),
    averagePrice: num(o.ap),
    realizedPnl: num(o.rp),
  };
}
