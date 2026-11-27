import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jsonlOutbox, sendTelegram, type Outbox, type OutboxRow } from '../src/ops/telegram.js';

const CONFIGURED = { TELEGRAM_TRADING_BOT_TOKEN: 'trading-token', TELEGRAM_CHAT_ID: '42' } as const;
const okFetch = (status = 200) => (async () => new Response('{}', { status })) as unknown as typeof fetch;

function capture(): { rows: OutboxRow[]; outbox: Outbox } {
  const rows: OutboxRow[] = [];
  return { rows, outbox: { append: (row) => { rows.push(row); } } };
}

test('a delivered message is recorded as sent, with its channel, status and text', async () => {
  const { rows, outbox } = capture();
  const ok = await sendTelegram('<b>ENTRY</b> BTCUSDT', { channel: 'trading' }, { env: CONFIGURED, fetchImpl: okFetch(200), outbox });
  assert.equal(ok, true);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.channel, rows[0]!.sent, rows[0]!.httpStatus, rows[0]!.html], ['trading', true, 200, '<b>ENTRY</b> BTCUSDT']);
  assert.equal(rows[0]!.chars, '<b>ENTRY</b> BTCUSDT'.length);
});

test('a rejected message is recorded as not sent, with the HTTP status', async () => {
  const { rows, outbox } = capture();
  const ok = await sendTelegram('card', { channel: 'trading' }, { env: CONFIGURED, fetchImpl: okFetch(429), outbox });
  assert.equal(ok, false);
  assert.deepEqual([rows[0]!.sent, rows[0]!.httpStatus], [false, 429]);
});

test('a network failure is recorded as not sent with no status, and the error text is not kept', async () => {
  const { rows, outbox } = capture();
  const failing = (async () => { throw new Error('getaddrinfo https://api.telegram.org/bot123:secret failed'); }) as unknown as typeof fetch;
  const ok = await sendTelegram('card', { channel: 'trading' }, { env: CONFIGURED, fetchImpl: failing, outbox });
  assert.equal(ok, false);
  assert.deepEqual([rows[0]!.sent, rows[0]!.httpStatus], [false, null]);
  assert.ok(!JSON.stringify(rows[0]).includes('secret'), 'a row must never carry the token or the URL');
});

test('dry runs and unconfigured sends are not recorded: nothing reached the network', async () => {
  const { rows, outbox } = capture();
  await sendTelegram('card', {}, { env: { TELEGRAM_DRY_RUN: '1' }, outbox, log: () => {} });
  await sendTelegram('card', {}, { env: {}, outbox });
  assert.equal(rows.length, 0);
});

test('with an injected fetch and no outbox given, nothing is written to the default path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-outbox-'));
  const path = join(dir, 'outbox.jsonl');
  await sendTelegram('card', { channel: 'alert' }, { env: { ...CONFIGURED, TELEGRAM_OUTBOX_PATH: path }, fetchImpl: okFetch(200) });
  assert.equal(existsSync(path), false, 'tests with an injected fetch must not write a record');
});

test('an explicit null outbox records nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-outbox-'));
  const path = join(dir, 'outbox.jsonl');
  await sendTelegram('card', {}, { env: { ...CONFIGURED, TELEGRAM_OUTBOX_PATH: path }, fetchImpl: okFetch(200), outbox: null });
  assert.equal(existsSync(path), false);
});

test('the JSONL outbox writes one line per row and reads back as JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-outbox-'));
  const path = join(dir, 'nested', 'outbox.jsonl');
  const outbox = jsonlOutbox(path);
  outbox.append({ at: 1, channel: 'alert', silent: true, sent: true, httpStatus: 200, chars: 4, html: 'card' });
  outbox.append({ at: 2, channel: 'trading', silent: false, sent: false, httpStatus: null, chars: 4, html: 'card' });
  const lines = readFileSync(path, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as OutboxRow);
  assert.deepEqual(lines.map((r) => [r.at, r.sent]), [[1, true], [2, false]]);
});

test('an outbox that cannot be written never fails the send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-outbox-'));
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'a file, not a directory');
  const ok = await sendTelegram('card', { channel: 'trading' }, { env: CONFIGURED, fetchImpl: okFetch(200), outbox: jsonlOutbox(join(blocker, 'outbox.jsonl')) });
  assert.equal(ok, true);
});
