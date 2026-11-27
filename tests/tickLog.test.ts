import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TickLogWriter } from '../src/marketdata/ticks/TickLogWriter.js';
import { FileTickSink } from '../src/marketdata/ticks/FileTickSink.js';
import { TickLogReader } from '../src/marketdata/ticks/TickLogReader.js';
import { TickReplay } from '../src/marketdata/ticks/TickReplay.js';
import { computeParityHash } from '../src/marketdata/ticks/parity.js';
import type { DepthSnapshot } from '../src/microstructure/LocalOrderBook.js';

const T0 = Date.UTC(2026, 9, 25, 6, 0, 0);

test('TickLogWriter writes sequential events, rotates hourly with zstd, and creates sha256 manifest', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tick-log-test-'));
  try {
    let now = T0;
    const writer = new TickLogWriter({ dir, symbol: 'BTCUSDT', now: () => now });
    await writer.open({ format: 1, symbol: 'BTCUSDT', startedAt: now, streams: ['btcusdt@depth@100ms'] });

    // Append ws event with lossless ID exceeding 2^53
    writer.append('ws', { u: '9007199254740995', s: 'BTCUSDT' }, 'btcusdt@depth@100ms');

    // Hour roll forces rotation and zstd compression
    now += 3600 * 1000;
    writer.append('poll', { openInterest: 50000 });
    await writer.close();

    const reader = new TickLogReader({ dir, symbol: 'BTCUSDT' });
    const files = await reader.files();
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith('.zst')));

    const events = [];
    for await (const ev of reader.events()) events.push(ev);
    assert.equal(events.length, 3); // meta, ws, poll
    assert.equal(events[0].kind, 'meta');
    assert.equal(events[1].kind, 'ws');
    assert.equal((events[1].data as { u: string }).u, '9007199254740995');
    assert.equal(events[2].kind, 'poll');

    const report = await reader.verify();
    assert.equal(report.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TickLogWriter stops writing when maxBytesPerDay limit is exceeded', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tick-limit-test-'));
  try {
    let errCaught: Error | null = null;
    const writer = new TickLogWriter({
      dir,
      symbol: 'ETHUSDT',
      maxBytesPerDay: 500,
      onError: (err) => { errCaught = err; },
    });
    await writer.open({ format: 1, symbol: 'ETHUSDT', startedAt: T0, streams: [] });
    for (let i = 0; i < 20; i++) {
      writer.append('ws', { testPayload: 'some long string to consume bytes quickly in the log' });
    }
    assert.ok(writer.failed !== null || errCaught !== null);
    await writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TickReplay reproduces order book state and validates parityHash', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tick-replay-test-'));
  try {
    let simTime = T0;
    const writer = new TickLogWriter({ dir, symbol: 'BTCUSDT', compress: false, now: () => simTime });
    await writer.open({ format: 1, symbol: 'BTCUSDT', startedAt: simTime, streams: ['btcusdt@depth@100ms'] });

    const snap: DepthSnapshot = {
      lastUpdateId: 100,
      bids: [{ price: 50000, qty: 1.5 }],
      asks: [{ price: 50001, qty: 2.0 }],
    };
    writer.append('snapshot', snap);

    // Depth diff straddling snapshot: U=99, u=101, pu=98
    simTime = T0 + 10;
    writer.append('ws', {
      U: 99, u: 101, pu: 98, E: T0 + 10,
      b: [['50000', '1.8']], a: [['50001', '2.0']],
    }, 'btcusdt@depth@100ms');

    // Precompute parity hash to store in health event
    const replayMock = new TickReplay('BTCUSDT');
    replayMock.book.loadSnapshot(snap);
    replayMock.engine.onSnapshot(snap);
    replayMock.book.onDiff({ U: 99, u: 101, pu: 98, E: T0 + 10, b: [['50000', '1.8']], a: [['50001', '2.0']] });
    replayMock.engine.onDepth({ U: 99, u: 101, pu: 98, E: T0 + 10, b: [['50000', '1.8']], a: [['50001', '2.0']] }, T0 + 10);
    const emitted = replayMock.engine.sample(T0 + 1000);
    const reading = replayMock.engine.reading(T0 + 1000);
    const expectedHash = computeParityHash(reading, emitted, {
      buy: replayMock.engine.entryFriction('buy', 5000, T0 + 1000),
      sell: replayMock.engine.entryFriction('sell', 5000, T0 + 1000),
    });

    simTime = T0 + 1000;
    writer.append('health', {
      sampleAt: T0 + 1000,
      lagMs: 5,
      queue: 0,
      resyncs: 0,
      bookStatus: 'LIVE',
      top: { bid: 50000, ask: 50001, bidQty: 1.8, askQty: 2.0 },
      parityHash: expectedHash,
    });
    await writer.close();

    const reader = new TickLogReader({ dir, symbol: 'BTCUSDT' });
    const replay = new TickReplay('BTCUSDT');
    const report = await replay.run(reader, { assertParity: true });

    assert.equal(report.snapshots, 1);
    assert.equal(report.samples, 1);
    assert.equal(report.mismatches, 0);
    assert.equal(report.lastParityHash, expectedHash);
    assert.equal(replay.book.status, 'LIVE');
    assert.equal(replay.book.bestBid(), 50000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TickLogWriter allows re-opening within the same process without self-lockout', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tick-lock-test-'));
  try {
    const writer = new TickLogWriter({ dir, symbol: 'SOLUSDT', now: () => T0 });
    await writer.open({ format: 1, symbol: 'SOLUSDT', startedAt: T0, streams: [] });

    let threw = false;
    try {
      await writer.open({ format: 1, symbol: 'SOLUSDT', startedAt: T0 + 1000, streams: [] });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'Expected re-opening within same process not to self-lockout');
    await writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileTickSink forwards repeated meta calls to writer append without re-opening', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sink-meta-test-'));
  try {
    const sink = new FileTickSink({ dir });
    sink.meta('SOLUSDT', { format: 1, symbol: 'SOLUSDT', startedAt: T0, streams: ['s1'] });
    await new Promise((r) => setTimeout(r, 20));

    let openedTwice = false;
    const writer = (sink as unknown as { writers: Map<string, TickLogWriter> }).writers.get('SOLUSDT')!;
    const originalOpen = writer.open.bind(writer);
    writer.open = async () => {
      openedTwice = true;
      return originalOpen({ format: 1, symbol: 'SOLUSDT', startedAt: T0, streams: [] });
    };

    sink.meta('SOLUSDT', { format: 1, symbol: 'SOLUSDT', startedAt: T0 + 1000, streams: ['s2'] });
    assert.equal(openedTwice, false, 'Expected second meta call NOT to invoke writer.open()');

    await sink.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


