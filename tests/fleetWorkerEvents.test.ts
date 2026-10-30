import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SymbolTraderWorker } from '../src/minicpm/SymbolTraderWorker.js';
import type { MiniCpmService } from '../src/minicpm/MiniCpmService.js';
import type { FleetTradeEvent } from '../src/minicpm/FleetTelegram.js';
import type { Candle } from '../src/types.js';

/**
 * End-to-end proof that the fleet workers emit trade events for the Telegram sink: a real
 * SymbolTraderWorker against a local fake paper_exchange, driven through a full lifecycle
 * (LLM entry fill -> break-even lock -> take-profit exit). Shadow mode must stay silent and a
 * broken sink must never break trading.
 */

const STATE_PATH = path.resolve('data/minicpm-state.json');

interface CapturedOrder {
  side: string;
  quantity: number;
  executionPrice: number;
  reduceOnly: boolean;
  clientOrderId: string;
}

interface FakeExchange {
  url: string;
  orders: CapturedOrder[];
  close(): Promise<void>;
}

function startFakeExchange(): Promise<FakeExchange> {
  const orders: CapturedOrder[] = [];
  const positions: Record<string, unknown>[] = [];
  let nextId = 1;
  const server = http.createServer((req, res) => {
    const pathname = req.url ?? '/';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && pathname === '/api/account') {
        res.end(JSON.stringify({
          account_id: 'crypto-minicpm-test', currency: 'USD', margin: 10000,
          available_balance: 10000, locked_margin: 0, equity: 10000,
          unrealized_pnl: 0, realized_pnl: 0, positions_count: positions.length,
        }));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/positions') {
        res.end(JSON.stringify(positions));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/orders') {
        const order = JSON.parse(body).order as Record<string, unknown>;
        orders.push({
          side: String(order.side),
          quantity: Number(order.quantity),
          executionPrice: Number(order.execution_price),
          reduceOnly: order.reduce_only === true,
          clientOrderId: String(order.client_order_id),
        });
        if (order.reduce_only === true) {
          const idx = positions.findIndex((p) => p.symbol === order.symbol);
          if (idx >= 0) positions.splice(idx, 1);
        } else {
          positions.push({
            id: nextId, symbol: order.symbol, side: order.side === 'buy' ? 'long' : 'short',
            net_quantity: order.quantity, average_price: order.execution_price,
            current_price: order.execution_price, leverage: order.leverage,
            margin_type: 'isolated', liquidation_price: null, unrealized_pnl: 0,
          });
        }
        res.end(JSON.stringify({ id: nextId++, status: 'FILLED', filled_quantity: order.quantity }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/mark_prices') {
        res.end('{}');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        orders,
        // closeAllConnections first: without it server.close() waits out the keep-alive timeout on
        // undici's pooled sockets, and under the runner's parallel test-file load those lingering
        // sockets were the window where a torn-down server answered (or half-answered) a fetch.
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r(undefined));
        }),
      });
    });
  });
}

// The state store writes data/minicpm-state.json at cwd; snapshot and restore it around each
// test so worker persistence never leaks between tests (or into the repo).
function snapshotState(): { existed: boolean; content?: string } {
  return existsSync(STATE_PATH) ? { existed: true, content: readFileSync(STATE_PATH, 'utf8') } : { existed: false };
}

function restoreState(snapshot: { existed: boolean; content?: string }): void {
  if (snapshot.existed) writeFileSync(STATE_PATH, snapshot.content!, 'utf8');
  else if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
}

function clearState(): void {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH);
}

const mkCandles = (count: number, base: number): Candle[] =>
  Array.from({ length: count }, (_, i) => ({
    openTime: i * 900_000,
    open: base,
    high: base * 1.001,
    low: base * 0.999,
    close: base,
    volume: 10,
  }));

const EVALUATION = {
  markPrice: 100,
  btcCandles15m: mkCandles(30, 50_000),
  btcCandles1h: mkCandles(15, 50_000),
  symbolCandles15m: mkCandles(30, 100),
  symbolCandles1h: mkCandles(15, 100),
};

const RECOMMENDATION = {
  action: 'ENTER_LONG' as const,
  confidence: 0.9,
  entry: 100,
  stopLoss: 95,
  takeProfit: 110,
  reason: 'reclaimed support',
};

const llmStub = { analyze: async () => RECOMMENDATION } as unknown as MiniCpmService;

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a worker emits ENTRY, BREAK_EVEN and EXIT trade events across a full position lifecycle', async () => {
  const snapshot = snapshotState();
  clearState();
  const exchange = await startFakeExchange();
  const events: FleetTradeEvent[] = [];
  try {
    const worker = new SymbolTraderWorker(
      {
        symbol: 'TESTUSDT',
        accountId: 'crypto-minicpm-test',
        paperExchangeUrl: exchange.url,
        apiKey: 'test-key',
        marginPerPosition: 1000,
        leverage: 10,
        entriesEnabled: true,
        modelTag: 'qwen3.5:2b',
        onTradeEvent: (event) => events.push(event),
      },
      llmStub,
    );

    await worker.evaluate(EVALUATION);
    // executeEntry is fire-and-forget inside evaluate(): wait for the fill to land AND for the
    // worker's position view to be populated. onLiveTick() manages the position, so waiting on
    // state alone is the race that used to flake under CI's parallel test-file load: state flipped
    // to IN_POSITION while activePosition was still null until syncAccount()'s round-trips ended.
    await waitFor(() => {
      const status = worker.getStatus();
      return status.state === 'IN_POSITION' && status.activePosition !== null;
    });
    await waitFor(() => events.length >= 1);

    const entry = events[0]!;
    assert.equal(entry.kind, 'ENTRY');
    assert.equal(entry.symbol, 'TESTUSDT');
    assert.equal(entry.side, 'buy');
    assert.equal(entry.action, 'ENTER_LONG');
    assert.equal(entry.model, 'qwen3.5:2b');
    assert.equal(entry.price, 100);
    assert.equal(entry.entryPrice, 100);
    assert.equal(entry.stopLoss, 95);
    assert.equal(entry.takeProfit, 110);
    assert.equal(entry.quantity, 98, 'notional 1000 * 0.98 * 10x / 100');
    assert.equal(entry.leverage, 10);
    assert.equal(entry.note, 'reclaimed support');
    assert.equal(exchange.orders.length, 1, 'exactly one entry order was submitted');
    assert.equal(exchange.orders[0]!.side, 'buy');
    assert.equal(exchange.orders[0]!.reduceOnly, false);

    // +1% move: the break-even lock fires (no order, a protection event)
    await worker.onLiveTick(101);
    assert.equal(events.length, 2);
    const breakEven = events[1]!;
    assert.equal(breakEven.kind, 'BREAK_EVEN');
    assert.equal(breakEven.symbol, 'TESTUSDT');
    assert.equal(breakEven.stopLoss, 100, 'SL locked at entry');
    assert.equal(breakEven.entryPrice, 100);
    assert.equal(breakEven.price, 101);
    assert.equal(breakEven.side, undefined, 'a protection event carries no order side');
    assert.equal(exchange.orders.length, 1, 'the break-even lock submits no order');

    // TP hit: the exit fill carries the reason, the entry and the realized PnL
    await worker.onLiveTick(111);
    assert.equal(events.length, 3);
    const exit = events[2]!;
    assert.equal(exit.kind, 'EXIT');
    assert.equal(exit.side, 'sell');
    assert.equal(exit.action, 'TAKE_PROFIT');
    assert.equal(exit.price, 111);
    assert.equal(exit.entryPrice, 100);
    assert.equal(exit.pnl, 1078, '(111 - 100) * 98');
    assert.equal(exit.quantity, 98);
    assert.equal(exit.stopLoss, 100, 'reports the guarding level at exit (the BE stop)');
    assert.equal(exit.takeProfit, 110);
    assert.equal(exchange.orders.length, 2);
    assert.equal(exchange.orders[1]!.side, 'sell');
    assert.equal(exchange.orders[1]!.reduceOnly, true, 'exits are reduce-only');
    assert.equal(worker.getStatus().state, 'IDLE', 'worker returned to idle after the exit');
  } finally {
    await exchange.close();
    restoreState(snapshot);
  }
});

test('shadow mode never emits trade events (no order, no notification)', async () => {
  const snapshot = snapshotState();
  clearState();
  const exchange = await startFakeExchange();
  const events: FleetTradeEvent[] = [];
  try {
    const worker = new SymbolTraderWorker(
      {
        symbol: 'TESTUSDT',
        accountId: 'crypto-minicpm-test',
        paperExchangeUrl: exchange.url,
        apiKey: 'test-key',
        marginPerPosition: 1000,
        leverage: 10,
        entriesEnabled: false,
        modelTag: 'qwen3.5:2b',
        onTradeEvent: (event) => events.push(event),
      },
      llmStub,
    );
    await worker.evaluate(EVALUATION);
    assert.equal(events.length, 0, 'a shadow decision is not a trade event');
    assert.equal(exchange.orders.length, 0);
    assert.match(worker.getStatus().lastDecision, /\[SHADOW\]/);
  } finally {
    await exchange.close();
    restoreState(snapshot);
  }
});

test('a throwing notification sink never breaks trading', async () => {
  const snapshot = snapshotState();
  clearState();
  const exchange = await startFakeExchange();
  try {
    const worker = new SymbolTraderWorker(
      {
        symbol: 'TESTUSDT',
        accountId: 'crypto-minicpm-test',
        paperExchangeUrl: exchange.url,
        apiKey: 'test-key',
        marginPerPosition: 1000,
        leverage: 10,
        entriesEnabled: true,
        modelTag: 'qwen3.5:2b',
        onTradeEvent: () => {
          throw new Error('sink down');
        },
      },
      llmStub,
    );
    await worker.evaluate(EVALUATION);
    await waitFor(() => {
      const status = worker.getStatus();
      return status.state === 'IN_POSITION' && status.activePosition !== null;
    });
    assert.equal(exchange.orders.length, 1, 'the entry still filled despite the broken sink');
    // The exit path must survive too
    await worker.onLiveTick(111);
    await waitFor(() => exchange.orders.length === 2);
    assert.equal(worker.getStatus().state, 'IDLE');
  } finally {
    await exchange.close();
    restoreState(snapshot);
  }
});
