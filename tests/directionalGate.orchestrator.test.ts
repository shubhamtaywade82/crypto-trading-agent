import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LoadedExperiment } from '../src/market/directional/live-gate.js';
import { buildTargetTable, DEFAULT_ADMISSION_POLICY, type AdmissionPolicy } from '../src/market/directional/probability.js';
import { synthLabels } from './directionalFixtures.js';
import type { Signal } from '../src/types.js';

// The Orchestrator writes its stores under data/ relative to cwd and reads config from env at import: isolate both.
const dir = mkdtempSync(path.join(tmpdir(), 'directional-orch-'));
process.chdir(dir);
process.env.MODE = 'paper';
process.env.DECISIONS_PATH = path.join(dir, 'decisions.jsonl');
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
const { Orchestrator } = await import('../src/runtime/Orchestrator.js');

const POLICY: AdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, minSample: 50, minDays: 5, bootstrapIterations: 300 };
const TABLE = buildTargetTable(synthLabels({ days: 40, perDay: 10, winRate: 0.75, tags: ['REJECTION_CONFIRMED'] }), 0.3, POLICY);

/** A minimal, valid experiment for the gate. Its bars are never loaded in these tests, so verdicts are UNAVAILABLE. */
const EXPERIMENT: LoadedExperiment = {
  dir: 'test',
  experiment: 'EXP-ORCH-TEST',
  config: {
    experiment: 'EXP-ORCH-TEST', description: 'test', symbols: ['SOLUSDT'], window: { from: '2026-01-01', to: '2026-02-01' },
    timeframe: '5m', costs: { feeBpsPerSide: 4, slippageBpsPerSide: 2 }, fundingSource: 'file', stopBufferAtr: 0.1,
    targetsPct: [1, 2], horizonsHours: [1], holdoutFraction: 0.3, criterionId: 'HOLDOUT_V1', tagsOfInterest: ['REJECTION_CONFIRMED'],
  },
  table: TABLE,
  gitHead: 'abc',
  workingTreeClean: true,
  calibratedCells: 1,
};

function harness(state: Record<string, unknown> | null) {
  const orch = new Orchestrator() as any;
  const logs: string[] = [];
  const executed: string[] = [];
  orch.on('log', (e: { msg: string }) => logs.push(e.msg));
  orch.frictionGate = 'off';
  orch.microFeed = null;
  if (state) orch.directional = { experiment: null, maxStopPct: 3, maxBarAgeMs: 900_000, refusal: null, ...state };
  orch.risk = { gate: () => ({ approved: true, positionSizeUsdt: 5_000, leverage: 5, marginType: 'ISOLATED', liqBufferAtr: 2, reason: 'ok' }) };
  orch.isVetoed = async () => false;
  orch.executor = {
    execute: async (s: Signal) => {
      executed.push(`${s.type} ${s.symbol}`);
      return { ts: Date.now(), agent: s.agent, msg: `OPENED ${s.symbol}`, level: 'success' };
    },
  };
  return { orch, logs, executed };
}

const signal = (type: Signal['type'], agent: Signal['agent'] = 'MOMENTUM-γ'): Signal => ({
  id: `d-${type}-${Math.random()}`, agent, symbol: 'SOLUSDT', type, confidence: 0.7, entry: 100.01,
  stopLoss: type === 'OPEN_SHORT' ? 101 : 99, takeProfit: type === 'OPEN_SHORT' ? 98 : 102, reason: 'test', ts: Date.now(),
});
const ctx = { equity: 100_000, positions: [], marketState: {}, marketDataV2: {}, funding: {} } as any;
const journal = () => readFileSync(process.env.DECISIONS_PATH!, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

test('with the gate off, the entry path is unchanged and nothing is journaled as directional', async () => {
  const { orch, executed } = harness(null);
  await orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(executed, ['OPEN_LONG SOLUSDT']);
  const row = journal().at(-1);
  assert.equal(row.status, 'EXECUTED');
  assert.equal(row.directional, undefined);
});

test('shadow records a directional verdict in the journal and still sends the entry', async () => {
  const { orch, logs, executed } = harness({ mode: 'shadow', experiment: EXPERIMENT });
  await orch.processSignals([signal('OPEN_LONG', 'MOMENTUM-γ')], ctx);
  assert.deepEqual(executed, ['OPEN_LONG SOLUSDT'], 'shadow never blocks');
  const row = journal().at(-1);
  assert.equal(row.status, 'EXECUTED');
  assert.equal(row.directional.mode, 'shadow');
  assert.equal(row.directional.blocked, false);
  assert.equal(row.directional.wouldBlock, true, 'no bars are loaded, so the verdict is unavailable');
  assert.ok(logs.some((m) => m.startsWith('DIRECTIONAL (shadow) would block SOLUSDT LONG')));
});

test('enforce fails closed when the directional data is unavailable, and the entry is never sent', async () => {
  const { orch, executed } = harness({ mode: 'enforce', experiment: EXPERIMENT });
  await orch.processSignals([signal('OPEN_LONG', 'MOMENTUM-γ')], ctx);
  assert.deepEqual(executed, []);
  const row = journal().at(-1);
  assert.equal(row.status, 'DIRECTIONAL_REJECTED');
  assert.match(row.rejectionReason, /^directional: UNAVAILABLE: INSUFFICIENT_HISTORY 0<60/);
  assert.equal(row.directional.blocked, true);
});

test('enforce refused at startup blocks every entry, and the refusal is journaled', async () => {
  const { orch, executed } = harness({ mode: 'enforce', experiment: null, refusal: 'config.json does not match the hash recorded in manifest.json' });
  await orch.processSignals([signal('OPEN_SHORT', 'STRUCTURE-TREND-η')], ctx);
  assert.deepEqual(executed, []);
  const row = journal().at(-1);
  assert.equal(row.status, 'DIRECTIONAL_REJECTED');
  assert.match(row.rejectionReason, /gate refused: config.json does not match/);
});

test('a CLOSE is never gated by the directional gate, even when enforce is refused', async () => {
  const { orch, executed } = harness({ mode: 'enforce', experiment: null, refusal: 'refused' });
  await orch.processSignals([signal('CLOSE')], ctx);
  assert.deepEqual(executed, ['CLOSE SOLUSDT']);
});

test('at startup, enforce without an experiment is refused with an error log, and no refresh timer starts', () => {
  const saved = { gate: process.env.DIRECTIONAL_GATE, dir: process.env.DIRECTIONAL_EXPERIMENT_DIR, stop: process.env.DIRECTIONAL_MAX_STOP_PCT };
  try {
    process.env.DIRECTIONAL_GATE = 'enforce';
    delete process.env.DIRECTIONAL_EXPERIMENT_DIR;
    process.env.DIRECTIONAL_MAX_STOP_PCT = '3';
    const { orch, logs } = harness(null);
    orch.startDirectional();
    assert.equal(orch.directional.mode, 'enforce');
    assert.match(orch.directional.refusal ?? '', /DIRECTIONAL_EXPERIMENT_DIR/);
    assert.ok(logs.some((m) => m.startsWith('DIRECTIONAL gate enforce refused') && m.includes('New entries are refused')));
    assert.equal(orch.directionalTimer, null);
  } finally {
    for (const [key, value] of [['DIRECTIONAL_GATE', saved.gate], ['DIRECTIONAL_EXPERIMENT_DIR', saved.dir], ['DIRECTIONAL_MAX_STOP_PCT', saved.stop]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('with the gate off at startup, nothing is loaded, logged or scheduled', () => {
  const saved = process.env.DIRECTIONAL_GATE;
  try {
    delete process.env.DIRECTIONAL_GATE;
    const { orch, logs } = harness(null);
    orch.startDirectional();
    assert.equal(orch.directional.mode, 'off');
    assert.equal(orch.directionalTimer, null);
    assert.equal(logs.filter((m) => m.includes('DIRECTIONAL')).length, 0);
  } finally {
    if (saved === undefined) delete process.env.DIRECTIONAL_GATE;
    else process.env.DIRECTIONAL_GATE = saved;
  }
});
