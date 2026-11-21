import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalOrderBook } from '../src/microstructure/LocalOrderBook.js';
import { parseJsonLossless } from '@nemesis-oss/binance-sdk';

const T0 = 1700000000000;

test('golden fixture: first event straddles snapshot', () => {
  const book = new LocalOrderBook();
  book.loadSnapshot({
    lastUpdateId: 500,
    bids: [{ price: 100, qty: 1 }],
    asks: [{ price: 102, qty: 1 }],
  });
  // U=499, u=502 straddles 500
  const res = book.onDiff({ U: 499, u: 502, pu: 498, E: T0, b: [['100', '2']], a: [] });
  assert.equal(res, 'applied');
  assert.equal(book.status, 'LIVE');
});

test('golden fixture: pu gap causes RESYNC_REQUIRED', () => {
  const book = new LocalOrderBook();
  book.loadSnapshot({
    lastUpdateId: 500,
    bids: [{ price: 100, qty: 1 }],
    asks: [{ price: 102, qty: 1 }],
  });
  book.onDiff({ U: 499, u: 502, pu: 498, E: T0, b: [], a: [] });
  assert.equal(book.status, 'LIVE');

  // Next event has pu=505 instead of 502
  const res = book.onDiff({ U: 506, u: 510, pu: 505, E: T0 + 100, b: [], a: [] });
  assert.equal(res, 'gap');
  assert.equal(book.status, 'RESYNC_REQUIRED');
  assert.match(book.reason, /sequence gap/);
});

test('golden fixture: snapshot too old for buffered U', () => {
  const book = new LocalOrderBook();
  // Buffer events before snapshot
  book.onDiff({ U: 100, u: 105, pu: 99, E: T0, b: [], a: [] });
  book.onDiff({ U: 106, u: 110, pu: 105, E: T0 + 10, b: [], a: [] });

  // Snapshot has lastUpdateId=200; buffered events have u=105, 110 < 200, so they get dropped
  // and the book remains in SYNCING until a straddling event arrives
  const res = book.loadSnapshot({
    lastUpdateId: 200,
    bids: [{ price: 100, qty: 1 }],
    asks: [{ price: 102, qty: 1 }],
  });
  assert.equal(res, 'applied');
  assert.equal(book.status, 'SYNCING');
});

test('golden fixture: crossed book triggers RESYNC_REQUIRED', () => {
  const book = new LocalOrderBook();
  book.loadSnapshot({
    lastUpdateId: 100,
    bids: [{ price: 100, qty: 1 }],
    asks: [{ price: 105, qty: 1 }],
  });
  // Bid set to 106 >= Ask 105
  const res = book.onDiff({ U: 99, u: 102, pu: 98, E: T0, b: [['106', '1']], a: [] });
  assert.equal(res, 'gap');
  assert.equal(book.status, 'RESYNC_REQUIRED');
  assert.match(book.reason, /crossed book/);
});

test('golden fixture: qty 0 removes level', () => {
  const book = new LocalOrderBook();
  book.loadSnapshot({
    lastUpdateId: 100,
    bids: [{ price: 100, qty: 5 }, { price: 99, qty: 2 }],
    asks: [{ price: 105, qty: 1 }],
  });
  book.onDiff({ U: 99, u: 101, pu: 98, E: T0, b: [['100', '0']], a: [] });
  assert.equal(book.bestBid(), 99);
  assert.deepEqual(book.levels('bids'), [[99, 2]]);
});

test('golden fixture: update id u > 2^53 is preserved losslessly', () => {
  const raw = '{"U":9007199254740992,"u":9007199254740995,"pu":9007199254740991,"s":"BTCUSDT"}';
  const parsed = parseJsonLossless(raw) as { U: unknown; u: unknown; pu: unknown };
  // Value exceeding Number.MAX_SAFE_INTEGER is preserved as string
  assert.equal(parsed.u, '9007199254740995');
  assert.equal(typeof parsed.u, 'string');
  assert.equal(String(parsed.pu), '9007199254740991');
});
