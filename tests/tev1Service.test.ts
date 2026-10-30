import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DecisionIntelligenceService, buildDecisionIntelligence } from '../src/decision-intelligence/services/decisionOrchestrator.js';
import { DecisionAuditRepository } from '../src/decision-intelligence/repositories/decisionAuditRepository.js';
import { QUESTION_SET_VERSION } from '../src/decision-intelligence/questions/questionRegistry.js';
import { POLICY_VERSION } from '../src/decision-intelligence/policies/tradeDecisionPolicy.js';
import type { Tev1Client } from '../src/decision-intelligence/clients/tev1Client.js';
import type { SystemoneRequest, SystemoneResponse } from '../src/decision-intelligence/types.js';
import type { MarketState } from '../src/market/types.js';
import type { Signal } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 28, 4, 24, 0);

/** Scripted client: records requests, replies per call. */
function fakeClient(script: ((request: SystemoneRequest) => SystemoneResponse | Promise<SystemoneResponse>) | Error) {
  const requests: SystemoneRequest[] = [];
  const client: Tev1Client = {
    async systemone(request) {
      requests.push(request);
      if (script instanceof Error) throw script;
      return script(request);
    },
  };
  return { client, requests };
}

const approveResponse: SystemoneResponse = {
  model: 'tev1:4b',
  answers: {
    trade_decision: { type: 'choice', choice: 'APPROVE', probabilities: { APPROVE: 0.8, WAIT: 0.1, NO_TRADE: 0.07, INSUFFICIENT_DATA: 0.03 }, confidence: 0.8 },
    primary_weakness: { type: 'choice', choice: 'NONE', probabilities: { NONE: 0.9 }, confidence: 0.9 },
    mtf_alignment: { type: 'noul', noul: 0.72 },
  },
  usage: { input_tokens: 690, output_tokens: 4 },
};

const signal: Signal = {
  id: 'sig-1', agent: 'STRUCTURE-TREND-η', symbol: 'SOLUSDT', type: 'OPEN_LONG', confidence: 0.72,
  entry: 101.72, stopLoss: 100.96, takeProfit: 103.4, reason: '4h bullish BOS, 15m reclaim retest', ts: NOW,
};

const state = {
  version: 1, symbol: 'SOLUSDT', generatedAt: NOW - 20 * 60_000, mark: 101.72, fundingRate: 0.0001,
  regime: { regime: 'TREND_UP', trendDirection: 'BULLISH', trendStrength: 0.6, volatility: 'MEDIUM', volatilityPercentile: 0.5, adx14: 28 },
  timeframes: {}, htfStructure: { timeframe: '4h', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null },
  ltfStructure: { timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null },
  liquidity: { htf: { timeframe: '4h', pools: [], latestSweeps: [], recentSweeps: [] }, ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] } },
  zones: [], pricing: { high: 102.41, low: 99.11, equilibrium: 100.76, positionPct: 79, premium: true, discount: false },
  meanReversion: { mean: null, vwap: null, zscore: null, rsi14: null, bollingerMiddle: null, bollingerUpper: null, bollingerLower: null, deviationPct: null },
  derivatives: { asOf: NOW, openInterest: 9_034_000, openInterestChangePct: -0.0053, globalLongShortRatio: 2.98, topTraderAccountLongShortRatio: null, topTraderPositionLongShortRatio: null, takerBuySellRatio: 0.8472, takerVolumeImbalance: -0.08, orderBookImbalance: -0.12, spreadBps: 0.9, basisPct: 0.004 },
  crowding: null,
} as unknown as MarketState;

const evidence = { breakdown: null, score: 68, factors: ['4h trend bullish'] };

function service(client: Tev1Client, mode: 'on' | 'shadow' = 'on', auditPath: string | null = null, logs: string[] = []) {
  return new DecisionIntelligenceService({
    mode, minConfidence: 0.6, model: 'tev1:4b', client,
    audit: new DecisionAuditRepository(auditPath),
    log: (message, level) => logs.push(`[${level}] ${message}`),
  });
}

// ─── The happy path ───

test('an APPROVE with aligned timeframes passes, and the wire request carries the snapshot and the versioned questions', async () => {
  const { client, requests } = fakeClient(() => approveResponse);
  const verdict = await service(client).evaluateCandidate({ decisionId: 'd1', signal, state, evidence, now: NOW });

  assert.equal(verdict.gate, 'PASS');
  assert.equal(verdict.action, 'PROCEED');
  assert.equal(verdict.enforced, true);
  assert.equal(verdict.choice, 'APPROVE');

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.model, 'tev1:4b');
  assert.equal((request.state as { symbol: string }).symbol, 'SOLUSDT');
  assert.match(request.questions.trade_decision!.instructions, /LONG candidate/);
  assert.ok(Object.keys(request.questions).includes('primary_weakness'));
  assert.ok(Object.keys(request.questions).includes('mtf_alignment'));
});

test('the audit row records model, versions, request, response, latency and verdict for replay', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tev1-service-'));
  const auditPath = path.join(dir, 'tev1-decisions.jsonl');
  const { client } = fakeClient(() => approveResponse);
  await service(client, 'on', auditPath).evaluateCandidate({ decisionId: 'd1', signal, state, evidence, now: NOW });

  const rows = new DecisionAuditRepository(auditPath).load();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.decisionId, 'd1');
  assert.equal(row.model, 'tev1:4b');
  assert.equal(row.questionSetVersion, QUESTION_SET_VERSION);
  assert.equal(row.policyVersion, POLICY_VERSION);
  assert.equal(row.mode, 'on');
  assert.ok(typeof row.latencyMs === 'number');
  assert.equal(row.response!.answers.trade_decision!.type, 'choice');
  assert.equal(row.verdict.action, 'PROCEED');
  assert.equal(row.error, null);
  assert.equal(row.snapshot.setup.side, 'LONG');
});

// ─── Fail-closed behavior ───

test('a client timeout in enforced mode is a non-approval, audited with the error, and never throws', async () => {
  const { client } = fakeClient(Object.assign(new Error('systemone request timed out after 8000ms'), { name: 'Tev1ClientError' }));
  const verdict = await service(client).evaluateCandidate({ decisionId: 'd2', signal, state, evidence, now: NOW });

  assert.equal(verdict.gate, 'BLOCK');
  assert.equal(verdict.action, 'REFUSE');
  assert.equal(verdict.choice, 'INSUFFICIENT_DATA');
  assert.match(verdict.reason, /unusable response/);
});

test('a malformed response is a non-approval with the invalid reasons in the verdict and audit', async () => {
  const { client } = fakeClient(() => ({ model: 'tev1:4b', answers: { trade_decision: { type: 'choice', choice: 'MAYBE', probabilities: {}, confidence: 0.9 } } }));
  const verdict = await service(client).evaluateCandidate({ decisionId: 'd3', signal, state, evidence, now: NOW });
  assert.equal(verdict.action, 'REFUSE');
  assert.match(verdict.reason, /was not offered/);
});

test('a candidate without geometry is refused before any model call', async () => {
  const { client, requests } = fakeClient(() => approveResponse);
  const verdict = await service(client).evaluateCandidate({ decisionId: 'd4', signal: { ...signal, stopLoss: undefined }, state, evidence, now: NOW });
  assert.equal(verdict.action, 'REFUSE');
  assert.match(verdict.reason, /geometry incomplete/);
  assert.equal(requests.length, 0);
});

test('a stale MarketState is refused before any model call', async () => {
  const { client, requests } = fakeClient(() => approveResponse);
  const stale = { ...state, generatedAt: NOW - 46 * 60_000 } as MarketState;
  const verdict = await service(client).evaluateCandidate({ decisionId: 'd5', signal, state: stale, evidence, now: NOW });
  assert.equal(verdict.action, 'REFUSE');
  assert.match(verdict.reason, /stale/);
  assert.equal(requests.length, 0);
});

// ─── Shadow mode ───

test('shadow mode computes and logs the same verdict without enforcing it', async () => {
  const logs: string[] = [];
  const { client } = fakeClient(() => ({
    ...approveResponse,
    answers: { ...approveResponse.answers, trade_decision: { type: 'choice', choice: 'NO_TRADE', probabilities: { NO_TRADE: 0.9 }, confidence: 0.9 } },
  }));
  const verdict = await service(client, 'shadow', null, logs).evaluateCandidate({ decisionId: 'd6', signal, state, evidence, now: NOW });
  assert.equal(verdict.gate, 'BLOCK');
  assert.equal(verdict.enforced, false);
  assert.ok(logs.some((line) => line.includes('(shadow) would block') && line.includes('NO_TRADE')));
});

// ─── Factory ───

test('buildDecisionIntelligence returns null when the gate is off, and a configured service otherwise', async () => {
  assert.equal(buildDecisionIntelligence({ mode: 'off', model: 'tev1:4b', minConfidence: 0.6, client: fakeClient(() => approveResponse).client, auditPath: null }), null);

  const logs: string[] = [];
  const built = buildDecisionIntelligence({ mode: 'shadow', model: 'tev1:0.8b', minConfidence: 0.7, client: fakeClient(() => approveResponse).client, auditPath: null, log: (m, l) => logs.push(`${l} ${m}`) });
  assert.ok(built !== null);
  const verdict = await built!.evaluateCandidate({ decisionId: 'd7', signal, state, evidence, now: NOW });
  assert.equal(verdict.mode, 'shadow');
  assert.ok(logs.some((line) => line.includes('tev1:0.8b') || line.includes('TEV1')));
});
