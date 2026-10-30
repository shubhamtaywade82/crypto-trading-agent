import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Signal } from '../src/types.js';
import type { TradeGateVerdict } from '../src/decision-intelligence/types.js';

// The Orchestrator writes its stores under data/ relative to cwd and reads config from env at import: isolate both.
const dir = mkdtempSync(path.join(tmpdir(), 'tev1-orch-'));
process.chdir(dir);
process.env.MODE = 'paper';
process.env.DECISIONS_PATH = path.join(dir, 'decisions.jsonl');
process.env.TEV1_AUDIT_PATH = path.join(dir, 'tev1-decisions.jsonl');
// No real Ollama in CI: the advisor gets a dead host, and the Tev1 service is stubbed per test below.
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.TEV1_GATE = 'off';
const { Orchestrator } = await import('../src/runtime/Orchestrator.js');
const { classifyRiskRefusal } = await import('../src/decision/NoTrade.js');

type Tev1Stub = {
  calls: { decisionId: string; symbol: string; type: string }[];
  verdict: TradeGateVerdict;
};

function verdict(over: Partial<TradeGateVerdict>): TradeGateVerdict {
  return { gate: 'BLOCK', action: 'REFUSE', enforced: true, mode: 'on', choice: 'NO_TRADE', confidence: 0.9, reason: 'tev1: NO_TRADE (primary weakness: TREND_CONFLICT)', ...over };
}

function harness(tev1: Tev1Stub | null) {
  const orch = new Orchestrator() as any;
  const logs: string[] = [];
  const executed: string[] = [];
  orch.on('log', (e: { agent: string; msg: string }) => logs.push(`${e.agent} ${e.msg}`));
  // This test targets the Tev1 gate only: the friction gate would fail closed with no live book.
  orch.frictionGate = 'off';
  orch.risk = { gate: () => ({ approved: true, positionSizeUsdt: 5_000, leverage: 5, marginType: 'ISOLATED', liqBufferAtr: 2, reason: 'ok' }) };
  orch.isVetoed = async () => false;
  orch.executor = { execute: async (s: Signal) => { executed.push(`${s.type} ${s.symbol}`); return { ts: Date.now(), agent: s.agent, msg: `OPENED ${s.symbol}`, level: 'success' }; } };
  if (tev1 !== null) {
    orch.tev1 = {
      evaluateCandidate: async (input: { decisionId: string; signal: Signal }) => {
        tev1.calls.push({ decisionId: input.decisionId, symbol: input.signal.symbol, type: input.signal.type });
        return tev1.verdict;
      },
    };
  } else {
    orch.tev1 = null; // TEV1_GATE=off
  }
  return { orch, logs, executed };
}

const signal = (type: Signal['type'], agent: Signal['agent'] = 'MOMENTUM-γ'): Signal => ({
  id: `s-${type}-${Math.random()}`, agent, symbol: 'SOLUSDT', type, confidence: 0.7,
  entry: 100.01, stopLoss: 99, takeProfit: 102, reason: 'test', ts: Date.now(),
});
const ctx = { equity: 100_000, positions: [], marketState: {}, marketDataV2: {}, funding: {} } as any;
const journal = () => (existsSync(process.env.DECISIONS_PATH!) ? readFileSync(process.env.DECISIONS_PATH!, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** Rows appended since a previous length — the journal file accumulates across tests. */
const rowsSince = (before: number) => journal().slice(before);

test('with the gate on, a BLOCK verdict journals TEV1_REJECTED and never sends the order', async () => {
  const stub: Tev1Stub = { calls: [], verdict: verdict({}) };
  const { orch, logs, executed } = harness(stub);
  const before = journal().length;
  await orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(executed, []);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].type, 'OPEN_LONG');
  const rejected = rowsSince(before).find((r) => r.status === 'TEV1_REJECTED');
  assert.ok(rejected, 'a TEV1_REJECTED record must be journaled');
  assert.match(rejected.rejectionReason, /^tev1: NO_TRADE/);
  assert.ok(logs.some((m) => m === 'TEV1 BLOCK SOLUSDT: tev1: NO_TRADE (primary weakness: TREND_CONFLICT)'));
});

test('a PASS verdict proceeds to execution and leaves no Tev1 status behind', async () => {
  const stub: Tev1Stub = { calls: [], verdict: verdict({ gate: 'PASS', action: 'PROCEED', choice: 'APPROVE', confidence: 0.8, reason: 'tev1: APPROVE mtf_alignment 0.72' }) };
  const { orch, executed } = harness(stub);
  const before = journal().length;
  await orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(executed, ['OPEN_LONG SOLUSDT']);
  assert.equal(rowsSince(before).some((r) => r.status === 'TEV1_REJECTED'), false);
});

test('a shadow BLOCK is logged but never refuses: the order still goes out', async () => {
  const stub: Tev1Stub = { calls: [], verdict: verdict({ enforced: false, mode: 'shadow' }) };
  const { orch, executed } = harness(stub);
  const before = journal().length;
  await orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(executed, ['OPEN_LONG SOLUSDT']);
  assert.equal(rowsSince(before).some((r) => r.status === 'TEV1_REJECTED'), false);
});

test('only entries are classified: CLOSE never reaches the gate', async () => {
  const stub: Tev1Stub = { calls: [], verdict: verdict({}) };
  const { orch, executed } = harness(stub);
  await orch.processSignals([signal('CLOSE')], ctx);
  assert.deepEqual(stub.calls, []);
  assert.deepEqual(executed, ['CLOSE SOLUSDT']);
});

test('with TEV1_GATE=off the service is absent and the candidate flows normally', async () => {
  const { orch, executed } = harness(null);
  await orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(executed, ['OPEN_LONG SOLUSDT']);
});

test('the gate runs after risk approval: a risk-refused candidate never spends a model call', async () => {
  const stub: Tev1Stub = { calls: [], verdict: verdict({}) };
  const { orch } = harness(stub);
  (orch.risk as any).gate = () => ({ approved: false, positionSizeUsdt: 0, leverage: 1, marginType: 'ISOLATED', liqBufferAtr: 0, reason: 'risk-engine: min_rr: below floor' });
  await orch.processSignals([signal('OPEN_LONG')], ctx);
  assert.deepEqual(stub.calls, []);
});

test('a tev1 refusal reason classifies to the TEV1_GATE code for the refusal summary', () => {
  assert.equal(classifyRiskRefusal('tev1: NO_TRADE (primary weakness: TREND_CONFLICT)'), 'TEV1_GATE');
  assert.equal(classifyRiskRefusal('tev1: unusable response — trade_decision: answer missing'), 'TEV1_GATE');
  assert.equal(classifyRiskRefusal('risk-engine: min_rr: below floor'), 'RR_TOO_LOW');
});
