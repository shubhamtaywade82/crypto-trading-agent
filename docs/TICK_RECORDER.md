# Raw Tick Recorder and Replay Engine

## Overview

The Raw Tick Recorder captures lossless market data frames directly from Binance USDⓈ-M public WebSocket endpoints and REST snapshots without aggregation or loss of precision. It provides the ground-truth event tape for market microstructure analysis, scalp signal backtesting, and execution simulation.

## Storage Architecture

- **Path structure**: `data/ticks/YYYY-MM-DD/HH/<SYMBOL>.jsonl`
- **Hourly rotation**: Completed active hours are automatically compressed to `.jsonl.zst` using Node 24 native Zstandard compression (`createZstdCompress`).
- **Single-writer lock**: Per-symbol lock files (`data/ticks/.locks/<SYMBOL>.lock`) prevent split-brain recording.
- **Disk guards**: Configurable per-symbol daily byte quota (`maxBytesPerDay`, default 4 GB/day) and filesystem minimum free space guard (`minFreeBytes`, default 2 GB) stop recording cleanly before exhausting storage.

## Manifest Verification

Each recording directory contains an append-only `manifest.jsonl` tracking finalized files:

```json
{
  "file": "2026-11-21/13/BTCUSDT.jsonl.zst",
  "symbol": "BTCUSDT",
  "startedAt": 1732185600000,
  "endedAt": 1732189200000,
  "firstSeq": 0,
  "lastSeq": 45120,
  "count": 45121,
  "bytes": 18239041,
  "compressedBytes": 2401823,
  "compression": "zstd",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

`TickLogReader` verifies SHA-256 hashes against `manifest.jsonl` upon reading.

## Event Schema

Every event is a single JSON line with `recvNs` decimal epoch nanoseconds:

```typescript
type TickEvent =
  | { seq: number; recvNs: string; kind: 'meta'; data: TickMeta }
  | { seq: number; recvNs: string; kind: 'ws'; stream: string; data: unknown }
  | { seq: number; recvNs: string; kind: 'snapshot'; data: DepthSnapshot }
  | { seq: number; recvNs: string; kind: 'poll'; source: string; data: unknown }
  | { seq: number; recvNs: string; kind: 'health'; data: TickHealth }
  | { seq: number; recvNs: string; kind: 'fill'; data: unknown };
```

### Event Kinds

1. `meta`: Stream metadata, SDK version, symbol specifications, recorded at session boot.
2. `ws`: Lossless-parsed frames from:
   - `/public`: `<sym>@depth@100ms` (order book diffs with `U`, `u`, `pu`)
   - `/market`: `<sym>@aggTrade`, `<sym>@markPrice@1s`, `<sym>@forceOrder`
3. `snapshot`: REST depth snapshots taken at startup and on book sequence gaps. Logged before being fed to `LocalOrderBook`.
4. `poll`: Periodic derivatives data:
   - `openInterest` every 5 seconds
   - Taker ratios, top-trader long/short ratios, and basis every 60 seconds
5. `health`: 1-second edge health sample including:
   - `sampleAt`: Exact epoch ms timestamp of the sample
   - `lagMs`: Book diff latency
   - `queue`: Count of buffered diffs awaiting snapshot join
   - `resyncs`: Count of book resyncs
   - `top`: Best bid, ask, bid quantity, ask quantity
   - `parityHash`: Canonical SHA-256 hash over reading, emitted liquidity events, and friction verdicts

## Replay and Parity

`TickReplay` replays recorded logs into `LocalOrderBook` and `MicrostructureEngine`:

- Reproduces the exact event ordering (snapshots before diffs, sequential diff chaining).
- When a `health` event is encountered, replay calls `engine.sample(health.sampleAt)`.
- Replay computes the canonical parity hash:
  `computeParityHash(reading, emitted, { buy, sell })`
- Asserts that live `parityHash` matches replayed `parityHash` with zero drift.

## Operational Commands

### Standalone Recorder
```bash
npm run record:ticks -- --symbols BTCUSDT,ETHUSDT --dir data/ticks
```

### Self-Check Verification
Verifies connectivity and parsers for 30 seconds:
```bash
npm run record:ticks:self-check
```

### Tick Replay
```bash
npm run replay:ticks -- --symbol BTCUSDT --dir data/ticks --assert-hash
```
