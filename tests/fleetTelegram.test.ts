import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fleetTelegramEnabled,
  formatFleetEventHtml,
  sendFleetEvent,
  type FleetTradeEvent,
} from '../src/minicpm/FleetTelegram.js';

interface CapturedCall {
  url: string;
  body: {
    text?: string;
    parse_mode?: string;
    chat_id?: string;
    disable_notification?: boolean;
  };
}

const makeFetch = (ok = true) => {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return { ok } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const CONFIGURED_ENV = {
  TELEGRAM_TRADING_BOT_TOKEN: 'trading-token',
  TELEGRAM_BOT_TOKEN: 'shared-token',
  TELEGRAM_CHAT_ID: '42',
} as const;

const ENTRY: FleetTradeEvent = {
  kind: 'ENTRY',
  symbol: 'ETHUSDT',
  side: 'buy',
  model: 'qwen3.5:2b',
  price: 2400.5,
  quantity: 4.083,
  leverage: 10,
  action: 'ENTER_LONG',
  note: 'reclaimed <support> & flipped bias',
  stopLoss: 2350,
  takeProfit: 2460,
  entryPrice: 2400.5,
  at: 1_700_000_000_000,
};

const EXIT: FleetTradeEvent = {
  kind: 'EXIT',
  symbol: 'ETHUSDT',
  side: 'sell',
  model: 'qwen3.5:2b',
  price: 111,
  quantity: 98,
  leverage: 10,
  action: 'TAKE_PROFIT',
  stopLoss: 100,
  takeProfit: 110,
  entryPrice: 100,
  pnl: 1078,
  at: 1_700_000_060_000,
};

const BREAK_EVEN: FleetTradeEvent = {
  kind: 'BREAK_EVEN',
  symbol: 'ETHUSDT',
  model: 'qwen3.5:2b',
  price: 101,
  action: 'BREAK_EVEN',
  note: 'SL moved to entry after +10.0% margin move',
  stopLoss: 100,
  takeProfit: 110,
  entryPrice: 100,
  at: 1_700_000_030_000,
};

test('fleet Telegram defaults to ON; FLEET_TELEGRAM=off/0/false/no is the opt-out', () => {
  assert.equal(fleetTelegramEnabled({}), true, 'unset => on');
  assert.equal(fleetTelegramEnabled({ FLEET_TELEGRAM: 'on' }), true);
  assert.equal(fleetTelegramEnabled({ FLEET_TELEGRAM: 'ON' }), true);
  assert.equal(fleetTelegramEnabled({ FLEET_TELEGRAM: ' off ' }), false, 'trimmed and case-insensitive');
  for (const value of ['off', '0', 'false', 'no']) {
    assert.equal(fleetTelegramEnabled({ FLEET_TELEGRAM: value }), false, `${value} => off`);
  }
});

test('an entry card is [FLEET]-tagged with symbol, side, action, levels and escaped model/reason', () => {
  const html = formatFleetEventHtml(ENTRY);
  assert.ok(html.startsWith('<b>[FLEET] ETHUSDT BUY — ENTER_LONG</b>'), html);
  assert.ok(html.includes('Entry $2400.50 · Qty 4.083 · 10x'), html);
  assert.ok(html.includes('SL $2350.00 · TP $2460.00'), html);
  assert.ok(html.includes('Model <code>qwen3.5:2b</code>'), html);
  // The reason is LLM output: it must arrive escaped, never raw HTML
  assert.ok(html.includes('reclaimed &lt;support&gt; &amp; flipped bias'), html);
  assert.ok(!html.includes('<support>'), 'raw unescaped angle brackets must not survive');
});

test('an exit card carries the exit reason and the signed realized PnL', () => {
  const html = formatFleetEventHtml(EXIT);
  assert.ok(html.startsWith('<b>[FLEET] ETHUSDT SELL — TAKE_PROFIT (+$1078.00)</b>'), html);
  assert.ok(html.includes('Exit $111.00 · Qty 98 · entered $100.00'), html);
  const losing = formatFleetEventHtml({ ...EXIT, action: 'STOP_LOSS', pnl: -52.5, price: 94.75 });
  assert.ok(losing.includes('SELL — STOP_LOSS (-$52.50)'), losing);
});

test('a break-even card is a protection notice without a buy/sell side', () => {
  const html = formatFleetEventHtml(BREAK_EVEN);
  assert.ok(html.startsWith('<b>[FLEET] ETHUSDT — BREAK-EVEN LOCKED</b>'), html);
  assert.ok(html.includes('SL moved to entry $100.00 at $101.00'), html);
  assert.ok(!/BUY|SELL/.test(html), 'no order side on a protection event');
});

test('sendFleetEvent posts the card to the trading bot with HTML parse mode', async () => {
  const { calls, fetchImpl } = makeFetch();
  const sent = await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl });
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.telegram.org/bottrading-token/sendMessage');
  assert.equal(calls[0]!.body.chat_id, '42');
  assert.equal(calls[0]!.body.parse_mode, 'HTML');
  assert.equal(calls[0]!.body.disable_notification, false, 'a buy/sell fill rings');
  assert.ok((calls[0]!.body.text ?? '').startsWith('<b>[FLEET] ETHUSDT BUY — ENTER_LONG</b>'), 'the card itself is [FLEET]-tagged');
});

test('sendFleetEvent falls back to the shared bot when no trading bot is configured', async () => {
  const { calls, fetchImpl } = makeFetch();
  const sent = await sendFleetEvent(EXIT, {
    env: { TELEGRAM_BOT_TOKEN: 'shared-token', TELEGRAM_CHAT_ID: '42' },
    fetchImpl,
  });
  assert.equal(sent, true);
  assert.equal(calls[0]!.url, 'https://api.telegram.org/botshared-token/sendMessage');
});

test('the break-even card arrives silently; buy/sell fills do not', async () => {
  const { calls, fetchImpl } = makeFetch();
  await sendFleetEvent(BREAK_EVEN, { env: CONFIGURED_ENV, fetchImpl });
  assert.equal(calls[0]!.body.disable_notification, true, 'break-even is informational');
  const { calls: entryCalls, fetchImpl: entryFetch } = makeFetch();
  await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl: entryFetch });
  assert.equal(entryCalls[0]!.body.disable_notification, false);
});

test('FLEET_TELEGRAM=off skips sending entirely', async () => {
  const { calls, fetchImpl } = makeFetch();
  const sent = await sendFleetEvent(ENTRY, { env: { ...CONFIGURED_ENV, FLEET_TELEGRAM: 'off' }, fetchImpl });
  assert.equal(sent, false);
  assert.equal(calls.length, 0, 'no HTTP call when opted out');
});

test('unconfigured Telegram resolves false without any HTTP call', async () => {
  const { calls, fetchImpl } = makeFetch();
  assert.equal(await sendFleetEvent(ENTRY, { env: {}, fetchImpl }), false);
  assert.equal(calls.length, 0);
});

test('TELEGRAM_DRY_RUN logs the card instead of sending it', async () => {
  const { calls, fetchImpl } = makeFetch();
  const lines: string[] = [];
  const sent = await sendFleetEvent(ENTRY, {
    env: { ...CONFIGURED_ENV, TELEGRAM_DRY_RUN: '1' },
    fetchImpl,
    log: (line) => lines.push(line),
  });
  assert.equal(sent, true);
  assert.equal(calls.length, 0);
  assert.ok(lines.some((l) => l.includes('[telegram dry-run]') && l.includes('[FLEET] ETHUSDT BUY')), lines.join('\n'));
});

test('a Telegram outage resolves false instead of throwing', async () => {
  const failingFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  assert.equal(await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl: failingFetch }), false);
  const notOkFetch = (async () => ({ ok: false })) as unknown as typeof fetch;
  assert.equal(await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl: notOkFetch }), false);
});
