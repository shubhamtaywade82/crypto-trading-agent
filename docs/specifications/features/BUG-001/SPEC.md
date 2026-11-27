# BUG-001: Resolve TickLogWriter Self-Lockout and FileTickSink Unhandled Rejections on Reconnect

## Overview
When `MicrostructureFeed` encounters an initial stream subscription failure or disconnect, it schedules a reconnection retry via backoff. On retry, `MicrostructureFeed.connect()` re-invokes `FileTickSink.meta()`, which currently calls `writer.open()` again for every symbol. In `TickLogWriter.acquireLock()`, the existing lock file contains the current process PID (`process.pid`), which triggers a self-lockout error (`Error: tick log <symbol> is already open by pid <pid>`). Because `FileTickSink` calls `void writer.open()`, the resulting promise rejection is unhandled and crashes the Node.js runtime.

## Problem
1. `TickLogWriter.acquireLock()` treats any existing lock with an active PID as a collision, even when `pid === process.pid`. This causes a process retrying or reopening its own symbol feed to crash.
2. `TickLogWriter.open()` is not idempotent: if called when a writer already has an active log or lock, it re-acquires the lock and overwrites `this.active` without flushing.
3. `FileTickSink.meta()` does not check `this.opened.has(symbol)`. Subsequent calls to `meta()` for the same symbol re-invoke `open()` instead of appending the meta record.
4. `FileTickSink` executes `void writer.open()`, which does not catch rejections and causes uncaught promise rejection crashes when opening fails.

## Scope
### In Scope
- Update `TickLogWriter.acquireLock()` to permit re-entry if the lock file already belongs to the current process (`pid === process.pid`).
- Ensure `TickLogWriter.open()` is idempotent if already opened for the same symbol.
- Update `FileTickSink.meta()` to check `this.opened.has(symbol)` and append to the existing writer rather than calling `open()` multiple times.
- Catch `writer.open()` rejections in `FileTickSink` and route errors to `this.options.onError`.
- Unit tests verifying:
  - Re-calling `writer.open()` within the same process does not throw `already open by pid <pid>`.
  - Re-calling `fileTickSink.meta()` for an opened symbol appends without re-opening.
  - Rejections in `open()` are safely forwarded to `onError`.

### Out of Scope
- Altering the on-disk tick JSONL or zstd compression format.
- Modifying Binance WebSocket subscription logic or backoff retry intervals.
- Modifying OrderBookDepthSource or MicrostructureEngine calculation logic.

## Actors
- `MicrostructureFeed`: Manages WebSocket connections and streams tick data to `TickSink`.
- `FileTickSink`: Multiplexes symbol feeds to individual `TickLogWriter` instances.
- `TickLogWriter`: Manages per-symbol hourly rotating JSONL tick files and lockfiles.

## Functional Requirements
- REQ-001: `TickLogWriter.acquireLock()` shall not throw an error when the lock file is held by `process.pid`.
- REQ-002: `TickLogWriter.open()` shall be idempotent and safely append subsequent `meta` calls if already opened.
- REQ-003: `FileTickSink.meta()` shall check whether a symbol is already opened and append the `meta` event instead of invoking `open()`.
- REQ-004: `FileTickSink` shall catch `writer.open()` failures and pass them to `this.options.onError`.

## Non-Functional Requirements
- NFR-001: Functions must adhere to KISS/YAGNI and project limits (functions <= 30 lines, nesting <= 3 levels).
- NFR-002: Regression tests must execute deterministically in under 5 seconds.

## Acceptance Criteria
- ACC-001: Calling `open()` twice sequentially on the same `TickLogWriter` instance succeeds without throwing.
- ACC-002: Re-acquiring a lock file already containing the current process PID does not throw `is already open`.
- ACC-003: Calling `FileTickSink.meta()` repeatedly for the same symbol appends events to the writer without re-opening or throwing.
- ACC-004: All regression tests in `tests/tickLog.test.ts` pass cleanly.

## Edge Cases
- Stale lock file from a dead process (`alive(pid) === false`): overwritten cleanly as before.
- Lock file held by an active different process (`pid !== process.pid && alive(pid) === true`): throws error as before.
- Malformed lock file (empty or non-numeric PID): overwritten cleanly.

## Dependencies
- Node.js test runner (`tsx --test`).
