import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MicrostructureEngine } from '../src/microstructure/MicrostructureEngine.js';
import type { Signal } from '../src/types.js';

// The Orchestrator writes its stores under data/ relative to cwd and reads config from env at import: isolate both.
const dir = mkdtempSync(path.join(tmpdir(), 'friction-orch-'));
process.chdir(dir);
process.env.MODE = 'paper';
process.env.DECISIONS_PATH = path.join(dir, 'decisions.jsonl');
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
const { Orchestrator } = await import('../src/runtime/Orchestrator.js');

/** 100.00 / 100.02 book: deep asks, thin bids. */
function book() {
  const e = new MicrostructureEngine('SOLUSDT');
  e.onSnapshot({
    lastUpdateId: 10,
    bids: Array.from({ length: 200 }, (_, i) => ({ price: Number((100 - i * 0.01).toFixed(2)), qty: 2 })),
    asks: Array.from({ length: 200 }, (_, i) => ({ price: Number((100.02 + i * 0.01).toFixed(2)), qty: 500 })),
  });
  e.onDepth({ U: 10, u: 11, pu: 9, E: Date.now(), b: [], a: [] }, Date.now());
  return e;
}

function harness(gate: 'on' | 'shadow' | 'off', engine: MicrostructureEngine | null) {
  const orch = new Orchestrator() as any;
  const logs: string[] = [];
  const executed: string[] = [];
  orch.on('log', (e: { msg: string }) => logs.push(e.msg));
  orch.frictionGate = gate;
  orch.microFeed = engine ? { engine: (s: string) => (s === 'SOLUSDT' ? engine : undefined) } : null;
  orch.risk = { gate: () => ({ approved: true, positionSizeUsdt: 5_000, leverage: 5, marginType: 'ISOLATED', liqBufferAtr: 2, reason: 'ok' }) };
  orch.isVetoed = async () => false;
  orch.executor = { execute: async (s: Signal) => { executed.push(`${s.type} ${s.symbol}`); return { ts: Date.now(), agent: s.agent, msg: `OPENED ${s.symbol}`, level: 'success' }; } };
  return { orch, logs, executed };
}

const signal = (type: Signal['type'], agent: Signal['agent'] = 'MOMENTUM-γ'): Signal => ({ id: `s-${type}-${Math.random()}`, agent, symbol: 'SOLUSDT', type, confidence: 0.7, entry: 100.01, stopLoss: type === 'OPEN_SHORT' ? 101 : 99, takeProfit: type === 'OPEN_SHORT' ? 98 : 102, reason: 'test', ts: Date.now() });
const ctx = { equity: 100_000, positions: [], marketState: {}, marketDataV2: {}, funding: {} } as any;
const journal = () => readFileSync(process.env.DECISIONS_PATH!, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

test('with the gate on, an entry the book cannot absorb is journaled FRICTION_REJECTED and never sent', async () => {
  const { orch, logs, executed } = harness('on', book());
  // Different agents: a filled entry starts a cooldown for its own symbol+agent
  await orch.processSignals([signal('OPEN_LONG'), signal('OPEN_SHORT', 'STRUCTURE-TREND-η')], ctx);
  assert.deepEqual(executed, ['OPEN_LONG SOLUSDT']); // 5k buy into deep asks passes; 5k sell into 2-SOL bids does not
  assert.ok(logs.some((m) => m === 'FRICTION BLOCK SOLUSDT sell $5000: sell slippage 13.0bps > 10'));
  const rows = journal();
  const rejected = rows.find((r) => r.status === 'FRICTION_REJECTED');
  assert.equal(rejected.rejectionReason, 'friction: sell slippage 13.0bps > 10');
  assert.equal(rejected.execution.friction.status, 'BLOCK');
  const sent = rows.find((r) => r.status === 'EXECUTED');
  assert.equal(sent.execution.friction.status, 'OK');
  assert.ok(sent.execution.friction.slipBps > 0.9 && sent.execution.friction.slipBps < 1.1);
});

test('with no live book the gate fails closed; in shadow it only logs; off it does not measure', async () => {
  const closed = harness('on', null);
  await closed.orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(closed.executed, []);
  assert.ok(closed.logs.some((m) => m.endsWith('microstructure feed not running')));

  const shadow = harness('shadow', book());
  await shadow.orch.processSignals([signal('OPEN_SHORT')], ctx);
  assert.deepEqual(shadow.executed, ['OPEN_SHORT SOLUSDT']);
  assert.ok(shadow.logs.some((m) => m.startsWith('FRICTION (shadow) would block SOLUSDT sell $5000')));

  const off = harness('off', null);
  await off.orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(off.executed, ['OPEN_LONG SOLUSDT']);
  assert.equal(journal().at(-1).execution.friction, undefined);
});

test('a CLOSE is never gated, even with no book at all', async () => {
  const { orch, executed } = harness('on', null);
  await orch.processSignals([signal('CLOSE')], ctx);
  assert.deepEqual(executed, ['CLOSE SOLUSDT']);
});
