import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRunId,
  describeSeries,
  fingerprintCandles,
  resolveResearchWindow,
  startOfUtcDay,
} from '../src/backtesting/researchRun.js';
import type { CandleWindow } from '../src/backtesting/candleIntegrity.js';
import type { Candle } from '../src/types.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 13, 22, 5); // 2026-11-06T13:22:05Z

const candle = (openTime: number, close = 100, volume = 1): Candle => ({
  openTime,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume,
});

describe('resolveResearchWindow', () => {
  it('api: ends now and starts `days` earlier, with no input bounds', () => {
    const w = resolveResearchWindow({ days: 30, endDaysAgo: 0, source: 'api', nowMs: NOW });
    assert.equal(w.toMs, NOW);
    assert.equal(w.fromMs, NOW - 30 * DAY);
    assert.equal(w.anchor, 'now');
  });

  it('api: endDaysAgo shifts the whole window into the past', () => {
    const w = resolveResearchWindow({ days: 20, endDaysAgo: 9, source: 'api', nowMs: NOW });
    assert.equal(w.toMs, NOW - 9 * DAY);
    assert.equal(w.fromMs, NOW - 29 * DAY);
  });

  it('archive: anchors at the start of yesterday, since the archive has no file for today and publishes a day late', () => {
    const w = resolveResearchWindow({ days: 20, endDaysAgo: 0, source: 'archive', nowMs: NOW });
    assert.equal(w.toIso, '2026-11-05T00:00:00.000Z');
    assert.equal(w.fromIso, '2026-10-16T00:00:00.000Z');
    assert.equal(w.anchor, 'start-of-previous-utc-day');
  });

  it('endMs fixes the window regardless of source or clock, and cannot lie in the future', () => {
    const endMs = NOW - 40 * DAY;
    for (const source of ['api', 'archive'] as const) {
      const w = resolveResearchWindow({ days: 10, endDaysAgo: 0, source, nowMs: NOW, endMs });
      assert.equal(w.toMs, endMs);
      assert.equal(w.fromMs, endMs - 10 * DAY);
      assert.equal(w.anchor, 'absolute');
    }
    assert.throws(() => resolveResearchWindow({ days: 10, endDaysAgo: 0, source: 'api', nowMs: NOW, endMs: NOW + 1 }), /endMs/);
  });

  it('archive: endDaysAgo 9 ends at 2026-10-27T00:00Z, before the 2026-10-28 15m hole in the archive', () => {
    const w = resolveResearchWindow({ days: 20, endDaysAgo: 9, source: 'archive', nowMs: NOW });
    assert.equal(w.toIso, '2026-10-27T00:00:00.000Z');
  });

  it('records the inputs it was computed from, so the run is explainable', () => {
    const w = resolveResearchWindow({ days: 5, endDaysAgo: 2, source: 'api', nowMs: NOW });
    assert.deepEqual(
      { days: w.days, endDaysAgo: w.endDaysAgo, source: w.source, nowMs: w.nowMs },
      { days: 5, endDaysAgo: 2, source: 'api', nowMs: NOW },
    );
    assert.equal(w.fromIso, new Date(w.fromMs).toISOString());
    assert.equal(w.toIso, new Date(w.toMs).toISOString());
  });

  it('rejects invalid input instead of producing a window', () => {
    assert.throws(() => resolveResearchWindow({ days: 0, endDaysAgo: 0, source: 'api', nowMs: NOW }), /days must be a positive/);
    assert.throws(() => resolveResearchWindow({ days: Number.NaN, endDaysAgo: 0, source: 'api', nowMs: NOW }), /days must be a positive/);
    assert.throws(() => resolveResearchWindow({ days: 5, endDaysAgo: -1, source: 'api', nowMs: NOW }), /endDaysAgo must be >= 0/);
    assert.throws(() => resolveResearchWindow({ days: 5, endDaysAgo: 0, source: 'ftp' as unknown as 'api', nowMs: NOW }), /source must be api or archive/);
    assert.throws(() => resolveResearchWindow({ days: 5, endDaysAgo: 0, source: 'api', nowMs: Number.NaN }), /nowMs must be finite/);
  });
});

describe('startOfUtcDay', () => {
  it('floors to the UTC midnight at or before the instant', () => {
    assert.equal(startOfUtcDay(NOW), Date.UTC(2026, 10, 6));
    assert.equal(startOfUtcDay(Date.UTC(2026, 10, 6)), Date.UTC(2026, 10, 6));
  });
});

describe('fingerprintCandles', () => {
  it('is stable for identical input and changes when any value changes', () => {
    const a = [candle(0, 100, 5), candle(900_000, 101, 6)];
    const b = [candle(0, 100, 5), candle(900_000, 101, 6)];
    const changedVolume = [candle(0, 100, 5), candle(900_000, 101, 7)];
    assert.equal(fingerprintCandles(a), fingerprintCandles(b));
    assert.notEqual(fingerprintCandles(a), fingerprintCandles(changedVolume));
  });

  it('is order-sensitive, so a reordered series is detected', () => {
    const a = [candle(0), candle(900_000, 101)];
    const reversed = [candle(900_000, 101), candle(0)];
    assert.notEqual(fingerprintCandles(a), fingerprintCandles(reversed));
  });

  it('hashes an empty series to the sha256 of the empty string', () => {
    assert.equal(fingerprintCandles([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('describeSeries', () => {
  it('reports the aligned window, the expected and actual bar counts, and the first and last bar', () => {
    const window: CandleWindow = { intervalMs: 900_000, fromMs: 0, toMs: 4 * 900_000 };
    const candles = [0, 1, 2, 3].map((i) => candle(i * 900_000));
    const record = describeSeries({ symbol: 'SOLUSDT', interval: '15m', source: 'api', window, candles });
    assert.equal(record.expectedBars, 4);
    assert.equal(record.bars, 4);
    assert.equal(record.fromIso, '1970-01-01T00:00:00.000Z');
    assert.equal(record.toIso, new Date(4 * 900_000).toISOString());
    assert.equal(record.firstOpenIso, '1970-01-01T00:00:00.000Z');
    assert.equal(record.lastOpenIso, new Date(3 * 900_000).toISOString());
    assert.equal(record.sha256, fingerprintCandles(candles));
  });

  it('reports a short series as fewer bars than expected, so the gap is visible in the manifest', () => {
    const window: CandleWindow = { intervalMs: 900_000, fromMs: 0, toMs: 4 * 900_000 };
    const record = describeSeries({ symbol: 'SOLUSDT', interval: '15m', source: 'archive', window, candles: [candle(0)] });
    assert.equal(record.expectedBars, 4);
    assert.equal(record.bars, 1);
  });
});

describe('buildRunId', () => {
  it('sanitises the label and appends a filesystem-safe UTC timestamp', () => {
    assert.equal(
      buildRunId('backtest', 'SOLUSDT-20d/archive', NOW),
      'backtest_SOLUSDT-20d-archive_2026-11-06T13-22-05-000Z',
    );
  });
});
