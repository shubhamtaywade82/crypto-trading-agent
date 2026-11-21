import assert from 'node:assert/strict';
import { LocalOrderBook, type DepthDiff, type DepthSnapshot } from '../../microstructure/LocalOrderBook.js';
import { MicrostructureEngine, type MicrostructureReading } from '../../microstructure/MicrostructureEngine.js';
import type { LiquidityEvent } from '../../microstructure/LiquidityEvents.js';
import { nsToMs, type TickEvent, type TickHealth } from './types.js';
import type { TickLogReader } from './TickLogReader.js';
import { computeParityHash } from './parity.js';

export interface TickReplayOptions {
  assertParity?: boolean;
  onSample?: (sampleAt: number, reading: MicrostructureReading, emitted: LiquidityEvent[]) => void;
}

export interface TickReplayReport {
  events: number;
  samples: number;
  snapshots: number;
  mismatches: number;
  lastParityHash: string | null;
}

/** Replays a recorded tick log into LocalOrderBook and MicrostructureEngine, verifying exact parity on health events. */
export class TickReplay {
  readonly book: LocalOrderBook;
  readonly engine: MicrostructureEngine;

  constructor(readonly symbol: string) {
    this.book = new LocalOrderBook();
    this.engine = new MicrostructureEngine(symbol);
  }

  async run(reader: TickLogReader, options: TickReplayOptions = {}): Promise<TickReplayReport> {
    const report: TickReplayReport = { events: 0, samples: 0, snapshots: 0, mismatches: 0, lastParityHash: null };
    for await (const event of reader.events()) {
      report.events += 1;
      this.handleEvent(event, options, report);
    }
    return report;
  }

  handleEvent(event: TickEvent, options: TickReplayOptions, report: TickReplayReport): void {
    if (event.kind === 'snapshot') {
      report.snapshots += 1;
      const snap = event.data as DepthSnapshot;
      this.book.loadSnapshot(snap);
      this.engine.onSnapshot(snap);
    } else if (event.kind === 'ws') {
      const recvMs = nsToMs(event.recvNs);
      this.handleWs(event.stream ?? '', event.data, recvMs);
    } else if (event.kind === 'health') {
      this.handleHealth(event.data as TickHealth, options, report);
    }
  }

  private handleWs(stream: string, data: any, recvMs: number): void {
    if (stream.includes('@depth')) {
      const diff: DepthDiff = {
        U: Number(data.U), u: Number(data.u), pu: data.pu !== undefined ? Number(data.pu) : undefined,
        E: Number(data.E), b: data.b ?? [], a: data.a ?? [],
      };
      this.book.onDiff(diff);
      this.engine.onDepth(diff, recvMs);
    } else if (stream.includes('@aggTrade')) {
      this.engine.onTrade({ time: Number(data.T), price: Number(data.p), qty: Number(data.q), buyerIsMaker: data.m === true });
    } else if (stream.includes('@forceOrder') || data?.e === 'forceOrder') {
      const o = data.o ?? data;
      const price = Number(o.ap || o.p || 0), qty = Number(o.q || o.l || 0);
      if (price > 0 && qty > 0) {
        this.engine.onLiquidation({ time: Number(o.T || data.E || recvMs), symbol: this.symbol, side: o.S === 'BUY' ? 'BUY' : 'SELL', price, qty, notional: price * qty });
      }
    }
  }

  private handleHealth(health: TickHealth, options: TickReplayOptions, report: TickReplayReport): void {
    report.samples += 1;
    const now = health.sampleAt;
    const emitted = this.engine.sample(now);
    const reading = this.engine.reading(now);
    options.onSample?.(now, reading, emitted);

    const buyFriction = this.engine.entryFriction('buy', 5000, now);
    const sellFriction = this.engine.entryFriction('sell', 5000, now);
    const hash = computeParityHash(reading, emitted, { buy: buyFriction, sell: sellFriction });
    report.lastParityHash = hash;

    if (health.parityHash && health.parityHash !== hash) {
      report.mismatches += 1;
      if (options.assertParity) {
        assert.equal(hash, health.parityHash, `parity mismatch at sampleAt ${now}`);
      }
    }
  }
}
