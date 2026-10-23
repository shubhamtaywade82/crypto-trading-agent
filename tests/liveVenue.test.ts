import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { USDMClient } from 'binance';
import type { AgentId } from '../src/types.js';

// Live mode is read from the environment when config loads, so it is set before the client module is imported
process.env.MODE = 'live';
process.env.ALERT_ONLY = 'off';
process.env.BINANCE_API_KEY ??= 'test-key';
process.env.BINANCE_API_SECRET ??= 'test-secret';
const { BinanceService } = await import('../src/binance/client.js');

interface FakeOrder {
  symbol: string; orderId: number; clientOrderId: string; type: string; side: 'BUY' | 'SELL'; status: string;
  price: string; origQty: string; executedQty: string; stopPrice: string; closePosition: boolean; reduceOnly: boolean;
}
interface FakePosition {
  symbol: string; positionSide: 'BOTH'; positionAmt: string; entryPrice: string; markPrice: string; unRealizedProfit: string;
  liquidationPrice: string; leverage: string; marginType: string;
}
interface FakeTrade {
  id: number; orderId: number; symbol: string; side: 'BUY' | 'SELL'; price: string; qty: string; realizedPnl: string;
  commission: string; commissionAsset: string; time: number;
}
interface Fault {
  method: string;
  error: unknown;
  /** The venue accepted the request, but the answer was lost on the way back. */
  landed?: boolean;
  match?: (params: any) => boolean;
}
interface Seed {
  orders?: FakeOrder[];
  positions?: FakePosition[];
  trades?: FakeTrade[];
  dualSide?: boolean;
}

const venueError = (code: number, message: string): Error => Object.assign(new Error(message), { code });

const order = (over: Partial<FakeOrder> & Pick<FakeOrder, 'orderId' | 'clientOrderId' | 'type' | 'side'>): FakeOrder => ({
  symbol: 'ETHUSDT', status: 'NEW', price: '0', origQty: '0', executedQty: '0', stopPrice: '0', closePosition: false, reduceOnly: false, ...over,
});
const stop = (over: Partial<FakeOrder> & Pick<FakeOrder, 'orderId' | 'clientOrderId'>): FakeOrder =>
  order({ type: 'STOP_MARKET', side: 'SELL', closePosition: true, ...over });
const longPosition = (qty: string): FakePosition => ({
  symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: qty, entryPrice: '100', markPrice: '100', unRealizedProfit: '0',
  liquidationPrice: '50', leverage: '5', marginType: 'isolated',
});
const ENTRY = {
  symbol: 'ETHUSDT', side: 'BUY' as const, qty: 0.5, leverage: 5, strategy: 'MOMENTUM-γ' as const, stopLoss: 95, takeProfit: 110, entryPrice: 100,
};

/**
 * A scripted USD-M account. It fills LIMIT entries at once, closes on reduce-only MARKET orders, and rejects duplicate
 * client ids and reduce-only orders with nothing to reduce, as the venue does. `faults` inject the failures under test.
 */
function venue(seed: Seed = {}) {
  const orders: FakeOrder[] = (seed.orders ?? []).map((o) => ({ ...o }));
  const positions: FakePosition[] = (seed.positions ?? []).map((p) => ({ ...p }));
  const calls: string[] = [];
  const faults: Fault[] = [];
  let nextOrderId = 9_000;

  const takeFault = (method: string, params: unknown): Fault | undefined => {
    const index = faults.findIndex((f) => f.method === method && (f.match?.(params) ?? true));
    return index < 0 ? undefined : faults.splice(index, 1)[0];
  };
  const openPositions = (): FakePosition[] => positions.filter((p) => Number(p.positionAmt) !== 0);
  const fill = (symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): void => {
    const delta = side === 'BUY' ? qty : -qty;
    const held = positions.find((p) => p.symbol === symbol);
    if (held) held.positionAmt = String(Number(held.positionAmt) + delta);
    else positions.push({ ...longPosition(String(delta)), symbol, entryPrice: String(price), markPrice: String(price) });
  };
  const place = (p: any): { orderId: number; status: string; executedQty: string } => {
    const orderId = nextOrderId++;
    if (p.type === 'MARKET' && p.reduceOnly === 'true') {
      const held = positions.find((x) => x.symbol === p.symbol);
      if (!held || Number(held.positionAmt) === 0) throw venueError(-2022, 'ReduceOnly Order is rejected.');
      fill(p.symbol, p.side, Number(p.quantity), 0);
      return { orderId, status: 'FILLED', executedQty: String(p.quantity) };
    }
    if (p.newClientOrderId && orders.some((o) => o.status === 'NEW' && o.clientOrderId === p.newClientOrderId)) {
      throw venueError(-4116, 'ClientOrderId is duplicated.');
    }
    const filled = p.type === 'LIMIT';
    orders.push(order({
      symbol: p.symbol, orderId, clientOrderId: p.newClientOrderId ?? `v${orderId}`, type: p.type, side: p.side,
      status: filled ? 'FILLED' : 'NEW', price: String(p.price ?? 0), origQty: String(p.quantity ?? 0),
      executedQty: filled ? String(p.quantity) : '0', stopPrice: String(p.stopPrice ?? 0),
      closePosition: p.closePosition === 'true', reduceOnly: p.reduceOnly === 'true',
    }));
    if (filled) fill(p.symbol, p.side, Number(p.quantity), Number(p.price));
    return { orderId, status: filled ? 'FILLED' : 'NEW', executedQty: filled ? String(p.quantity) : '0' };
  };

  const futures = {
    getCurrentPositionMode: async () => ({ dualSidePosition: seed.dualSide ?? false }),
    getAllOpenOrders: async (query: { symbol?: string } = {}) => orders.filter((o) => o.status === 'NEW' && (!query.symbol || o.symbol === query.symbol)),
    getPositionsV3: async () => openPositions(),
    getAccountInformation: async () => ({
      totalMarginBalance: '1000', totalInitialMargin: '0', positions: openPositions().map((p) => ({ ...p, isolated: true })),
    }),
    getAccountTrades: async ({ symbol, fromId }: { symbol: string; fromId?: number }) =>
      (seed.trades ?? []).filter((t) => t.symbol === symbol && (fromId === undefined || t.id >= fromId)),
    getIncomeHistory: async () => [],
    setLeverage: async () => ({}),
    setMarginType: async (params: unknown) => {
      const hit = takeFault('setMarginType', params);
      if (hit) throw hit.error;
    },
    getOrder: async ({ symbol, origClientOrderId }: { symbol: string; origClientOrderId: string }) => {
      const found = orders.find((o) => o.symbol === symbol && o.clientOrderId === origClientOrderId);
      if (!found) throw venueError(-2013, 'Order does not exist.');
      return found;
    },
    cancelOrder: async ({ symbol, orderId }: { symbol: string; orderId: number }) => {
      const found = orders.find((o) => o.symbol === symbol && o.orderId === orderId);
      if (!found || found.status !== 'NEW') throw venueError(-2011, 'Unknown order sent.');
      const hit = takeFault('cancelOrder', { symbol, orderId });
      if (hit) throw hit.error;
      found.status = 'CANCELED';
      calls.push(`cancel ${orderId}`);
    },
    cancelAllOpenOrders: async ({ symbol }: { symbol: string }) => {
      for (const o of orders) if (o.symbol === symbol && o.status === 'NEW') o.status = 'CANCELED';
      calls.push(`cancelAll ${symbol}`);
      return {};
    },
    submitNewOrder: async (params: any) => {
      calls.push(`submit ${params.type} ${params.side}${params.closePosition === 'true' ? ' close' : params.reduceOnly === 'true' ? ' reduce' : ''}`);
      const hit = takeFault('submitNewOrder', params);
      if (hit && !hit.landed) throw hit.error;
      const result = place(params);
      if (hit) throw hit.error;
      return result;
    },
  };
  return { futures: futures as unknown as USDMClient, orders, positions, calls, faults };
}

interface Internals {
  syncJournal(symbols: string[]): Promise<void>;
  reconcileLive(): Promise<void>;
  entries: { busy: boolean } | null;
  owners: { record(entry: { symbol: string; side: 'LONG' | 'SHORT'; strategy: AgentId; submittedAt: number; clientOrderId: string }): void };
}
const internals = (service: object): Internals => service as unknown as Internals;

/** A live service on a scripted venue, past its first journal sync and startup reconciliation, as the loop leaves it. */
async function liveService(seed: Seed = {}, { journal = true } = {}) {
  const v = venue(seed);
  const service = new BinanceService(null, v.futures, mkdtempSync(path.join(tmpdir(), 'live-venue-')));
  if (journal) await internals(service).syncJournal(['ETHUSDT']);
  await internals(service).reconcileLive();
  return { service, v };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const entryIdle = (service: object): boolean => !internals(service).entries?.busy;
const openProtection = (v: ReturnType<typeof venue>): FakeOrder[] => v.orders.filter((o) => o.status === 'NEW' && o.closePosition);

test('a filled entry is protected by a closePosition stop and target sized to the venue position', async () => {
  const { service, v } = await liveService();
  await service.openFuturesPosition(ENTRY);
  await waitFor(() => openProtection(v).length === 2 && entryIdle(service), 'protection');
  assert.deepEqual(openProtection(v).map((o) => [o.type, Number(o.stopPrice)]).sort(), [['STOP_MARKET', 95], ['TAKE_PROFIT_MARKET', 110]].sort());
});

test('an entry is refused, with no order sent, while a position on its symbol has no stop at the venue', async () => {
  const { service, v } = await liveService({ positions: [longPosition('0.5')] });
  await assert.rejects(service.openFuturesPosition(ENTRY), /UNPROTECTED/);
  assert.equal(v.calls.some((c) => c.startsWith('submit LIMIT')), false);
});

test('hedge mode at the venue refuses every entry', async () => {
  const { service, v } = await liveService({ dualSide: true });
  await assert.rejects(service.openFuturesPosition(ENTRY), /hedge mode/);
  assert.equal(v.calls.some((c) => c.startsWith('submit LIMIT')), false);
});

test('entries wait for the first journal sync, and say so', async () => {
  const { service } = await liveService({}, { journal: false });
  assert.match(service.entryBlockReason('ETHUSDT') ?? '', /trade journal/);
  await assert.rejects(service.openFuturesPosition(ENTRY), /trade journal/);
});

test('a failed isolated-margin change refuses the entry before any order is sent', async () => {
  const { service, v } = await liveService();
  v.faults.push({ method: 'setMarginType', error: venueError(-1000, 'Unknown error.') });
  await assert.rejects(service.openFuturesPosition(ENTRY), /Unknown error/);
  assert.equal(v.calls.some((c) => c.startsWith('submit')), false);
});

test('a symbol the venue already reports as isolated proceeds to the entry', async () => {
  const { service, v } = await liveService();
  v.faults.push({ method: 'setMarginType', error: venueError(-4046, 'No need to change margin type.') });
  await service.openFuturesPosition(ENTRY);
  assert.ok(v.calls.includes('submit LIMIT BUY'));
});

test('a stop the venue refuses is not retried, and the position is closed rather than left without protection', async () => {
  const { service, v } = await liveService();
  v.faults.push({ method: 'submitNewOrder', match: (p) => p.type === 'STOP_MARKET', error: venueError(-2021, 'Order would immediately trigger.') });
  await service.openFuturesPosition(ENTRY);
  await waitFor(() => entryIdle(service), 'entry to resolve');
  assert.equal(v.calls.filter((c) => c === 'submit STOP_MARKET SELL close').length, 1, 'a rejected stop is final');
  assert.ok(v.calls.includes('submit MARKET SELL reduce'), 'the emergency close is sent');
  assert.deepEqual(openProtection(v), []);
  assert.deepEqual(v.positions.filter((p) => Number(p.positionAmt) !== 0), []);
});

test('an ambiguous stop placement finds the stop that landed, and does not send a second one', async () => {
  const { service, v } = await liveService();
  v.faults.push({ method: 'submitNewOrder', match: (p) => p.type === 'STOP_MARKET', error: new Error('socket hang up'), landed: true });
  await service.openFuturesPosition(ENTRY);
  await waitFor(() => openProtection(v).length === 2 && entryIdle(service), 'protection');
  assert.equal(v.calls.filter((c) => c === 'submit STOP_MARKET SELL close').length, 1, 'the landed stop is found by client id');
  assert.equal(openProtection(v).filter((o) => o.type === 'STOP_MARKET').length, 1);
});

test('startup reconciliation cancels the bot\'s own resting entries and orphaned protection, and leaves orders it did not place', async () => {
  const seed: Seed = {
    orders: [
      order({ orderId: 1, clientOrderId: 'e1abc', type: 'LIMIT', side: 'BUY', price: '99', origQty: '0.5' }),
      stop({ orderId: 2, clientOrderId: 'p1orphan', stopPrice: '95' }),
      order({ orderId: 3, clientOrderId: 'manual-1', type: 'LIMIT', side: 'BUY', price: '90', origQty: '0.1' }),
    ],
  };
  const { service, v } = await liveService(seed);
  assert.deepEqual(v.orders.map((o) => [o.orderId, o.status]), [[1, 'CANCELED'], [2, 'CANCELED'], [3, 'NEW']]);
  assert.equal(service.entryBlockReason('ETHUSDT'), undefined);
});

test('cancelEntryOrders cancels only the bot\'s resting entries, and a venue answer that the order is gone is not an error', async () => {
  const { service, v } = await liveService({ positions: [longPosition('0.5')], orders: [stop({ orderId: 2, clientOrderId: 'p1live', stopPrice: '95' })] });
  // Entries rest only after startup: reconciliation would otherwise have cancelled them
  v.orders.push(
    order({ orderId: 1, clientOrderId: 'e1abc', type: 'LIMIT', side: 'BUY', price: '99', origQty: '0.5' }),
    order({ orderId: 4, clientOrderId: 'e1def', type: 'LIMIT', side: 'BUY', price: '98', origQty: '0.5' }),
  );
  v.faults.push({ method: 'cancelOrder', error: venueError(-2011, 'Unknown order sent.') });
  assert.equal(await service.cancelEntryOrders(), 1, 'the first entry was already gone; the second is cancelled');
  assert.deepEqual(v.orders.map((o) => [o.orderId, o.status]), [[2, 'NEW'], [1, 'NEW'], [4, 'CANCELED']]);
});

test('updateStops places the new stop before it cancels the old one', async () => {
  const seed: Seed = { positions: [longPosition('0.5')], orders: [stop({ orderId: 77, clientOrderId: 'p1old', stopPrice: '90' })] };
  const { service, v } = await liveService(seed);
  await service.updateStops('ETHUSDT', 'MOMENTUM-γ', 95, 110, 'LONG');
  const placed = v.calls.indexOf('submit STOP_MARKET SELL close');
  const cancelled = v.calls.indexOf('cancel 77');
  assert.ok(placed >= 0 && cancelled > placed, `placed at ${placed}, cancelled at ${cancelled}`);
  assert.equal(v.orders.find((o) => o.orderId === 77)?.status, 'CANCELED');
  assert.deepEqual(openProtection(v).map((o) => Number(o.stopPrice)).sort((a, b) => a - b), [95, 110]);
});

test('a new stop the venue refuses leaves the old stop in place', async () => {
  const seed: Seed = { positions: [longPosition('0.5')], orders: [stop({ orderId: 77, clientOrderId: 'p1old', stopPrice: '90' })] };
  const { service, v } = await liveService(seed);
  v.faults.push({ method: 'submitNewOrder', match: (p) => p.type === 'STOP_MARKET', error: venueError(-2021, 'Order would immediately trigger.') });
  await assert.rejects(service.updateStops('ETHUSDT', 'MOMENTUM-γ', 95, 110, 'LONG'), /Protection order failed/);
  assert.equal(v.orders.find((o) => o.orderId === 77)?.status, 'NEW');
  assert.equal(v.calls.some((c) => c.startsWith('cancel')), false);
});

test('the position view reports its real stop and target, and the strategy that opened it', async () => {
  const seed: Seed = {
    positions: [longPosition('0.5')],
    orders: [stop({ orderId: 5, clientOrderId: 'p1stop', stopPrice: '95' }), order({ orderId: 6, clientOrderId: 'p1tp', type: 'TAKE_PROFIT_MARKET', side: 'SELL', closePosition: true, stopPrice: '110' })],
  };
  const { service } = await liveService(seed);
  internals(service).owners.record({ symbol: 'ETHUSDT', side: 'LONG', strategy: 'MOMENTUM-γ', submittedAt: Date.now() - 1_000, clientOrderId: 'e1abc' });
  const [position] = await service.getPositions();
  assert.equal(position.strategy, 'MOMENTUM-γ');
  assert.equal(Number(position.serverSl), 95);
  assert.equal(Number(position.serverTp), 110);
});

test('the live trade history is the venue\'s fills, journaled and reported by getTrades', async () => {
  const trades: FakeTrade[] = [{
    id: 1, orderId: 11, symbol: 'ETHUSDT', side: 'SELL', price: '110', qty: '1', realizedPnl: '10', commission: '0.1', commissionAsset: 'USDT', time: 1_000,
  }];
  const { service } = await liveService({ trades });
  const [closed] = service.getTrades();
  assert.equal(service.getTrades().length, 1);
  assert.equal(closed.side, 'LONG');
  assert.ok(Math.abs(closed.entry - 100) < 1e-9);
  assert.ok(Math.abs(closed.pnl - 9.9) < 1e-9);
});
