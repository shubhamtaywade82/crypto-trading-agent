import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchFlowMinutes, parseFlowKlineCsv, planArchiveFiles } from '../src/market/directional/archive-flow.js';

const SYMBOL = 'SOLUSDT';

/** A one-entry zip with the stored method (0), as the reader in archiveKlines.ts expects. */
function storedZip(name: string, text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10); // method: stored
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const cdOffset = 30 + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

/** A twelve-column archive row, as data.binance.vision publishes klines: open_time first, taker buy at index 9. */
const row = (t: number, o: number, h: number, l: number, c: number, vol: number, quote: number, count: number, takerBuy: number): string =>
  [t, o, h, l, c, vol, t + 59_999, quote, count, takerBuy, takerBuy * c, 0].join(',');

test('parses the twelve-column layout and skips a header row', () => {
  const text = ['open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
    row(1_700_000_000_000, 100, 101, 99, 100.5, 10, 1005, 42, 6)].join('\n');
  const [m] = parseFlowKlineCsv(text, SYMBOL);
  assert.ok(m);
  assert.equal(m.openTime, 1_700_000_000_000);
  assert.equal(m.close, 100.5);
  assert.equal(m.baseVolume, 10);
  assert.equal(m.quoteVolume, 1005);
  assert.equal(m.trades, 42);
  assert.equal(m.takerBuyBaseVolume, 6);
  assert.equal(m.symbol, SYMBOL);
});

test('refuses a timestamp that is not in milliseconds, and a data row that is too short', () => {
  assert.throws(() => parseFlowKlineCsv(row(1_700_000_000_000_000, 1, 1, 1, 1, 1, 1, 1, 0), SYMBOL), /not a millisecond timestamp/);
  assert.throws(() => parseFlowKlineCsv('1700000000000,1,2,3', SYMBOL), /expected at least 10 columns/);
});

test('planning: complete published months are monthly files, the rest are daily, and unpublished days are reported', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = Date.UTC(2026, 2, 25);
  const now = Date.UTC(2026, 2, 20, 12);
  const plan = planArchiveFiles(SYMBOL, from, to, now);
  assert.deepEqual(plan.files.filter((f) => f.kind === 'monthly').map((f) => f.key), ['2026-01', '2026-02']);
  assert.equal(plan.files.filter((f) => f.kind === 'daily').length, 19, 'March 1 to 19 are published');
  assert.deepEqual(plan.unavailableDays, ['2026-03-20', '2026-03-21', '2026-03-22', '2026-03-23', '2026-03-24']);
  assert.equal(plan.files[0]?.url, `https://data.binance.vision/data/futures/um/monthly/klines/${SYMBOL}/1m/${SYMBOL}-1m-2026-01.zip`);
});

test('fetch: reads the zip, keeps only minutes inside the window, and refuses HTTP errors and unpublished windows', async () => {
  const from = Date.UTC(2026, 0, 1);
  const to = Date.UTC(2026, 1, 1);
  const now = Date.UTC(2026, 5, 1);
  const text = [
    row(Date.UTC(2025, 11, 31, 23, 59), 1, 1, 1, 1, 1, 1, 1, 0),
    row(from, 100, 101, 99, 100, 1, 100, 1, 0.5),
    row(from + 60_000, 100, 101, 99, 100, 1, 100, 1, 0.5),
  ].join('\n');
  const zip = storedZip('SOLUSDT-1m-2026-01.csv', text);
  const ok = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(zip).buffer });
  const got = await fetchFlowMinutes(SYMBOL, from, to, ok, now);
  assert.equal(got.minutes.length, 2);
  assert.equal(got.files, 1);

  const notFound = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(() => fetchFlowMinutes(SYMBOL, from, to, notFound, now), /ARCHIVE_HTTP 404/);

  await assert.rejects(
    () => fetchFlowMinutes(SYMBOL, from, Date.UTC(2026, 5, 10), ok, Date.UTC(2026, 5, 2)),
    /ARCHIVE_UNAVAILABLE/,
  );
});
