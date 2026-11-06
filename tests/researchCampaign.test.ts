import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AgentChatClient } from '@nemesis-oss/ollama-sdk';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { campaignSchema, readJournal, registrationProblems, type Campaign } from '../src/research/pipeline/campaign.js';
import { buildTools, runCampaignAgent, type AgentContext } from '../src/research/pipeline/campaignAgent.js';
import { parseSpec, type HypothesisSpec } from '../src/research/pipeline/hypothesis.js';
import type { OosRead } from '../src/research/pipeline/oosLedger.js';
import type { Candle } from '../src/types.js';

const HOUR_MS = 3_600_000;
const CAMPAIGN: Campaign = campaignSchema.parse({
  schemaVersion: 1, id: 'TEST-CAMPAIGN', description: 'campaign used by the tests', alpha: 0.05, maxRegistrations: 1, maxEvaluations: 2,
  window: { endIso: '2026-01-01T00:00:00.000Z', days: 400, split: { trainPct: 60, validationPct: 20, testPct: 20 } },
  symbols: ['SOLUSDT', 'ETHUSDT'], timeframes: ['1h'],
});

/** Seeded random walk on the 1h grid of [fromMs, toMs). */
function walkCandles(fromMs: number, toMs: number, seed: number): Candle[] {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let close = 100;
  for (let t = fromMs; t < toMs; t += HOUR_MS) {
    const open = close;
    close = open * (1 + (rand() + rand() + rand() - 1.5) * 0.02);
    candles.push({ openTime: t, open, high: Math.max(open, close) * (1 + 0.004 * rand()), low: Math.min(open, close) * (1 - 0.004 * rand()), close, volume: 1 });
  }
  return candles;
}

function withContext<T>(run: (ctx: AgentContext, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'campaign-'));
  mkdirSync(path.join(dir, 'specs', 'proposed'), { recursive: true });
  const ctx: AgentContext = {
    campaign: CAMPAIGN, specsDir: path.join(dir, 'specs'), proposedDir: path.join(dir, 'specs', 'proposed'),
    journalFile: path.join(dir, 'journal.jsonl'), ledgerFile: path.join(dir, 'ledger.jsonl'), runId: 'run-1',
    loadCandles: async (symbol, _timeframe, fromMs, toMs) => walkCandles(fromMs, toMs, symbol === 'SOLUSDT' ? 1 : 2),
    log: () => undefined,
  };
  return run(ctx, dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const draftArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'LLM-TEST-BREAKOUT-1', hypothesis: 'Stops resting above compressed ranges fill on the break and extend the move.',
  symbols: ['SOLUSDT', 'ETHUSDT'], timeframes: ['1h'], params: { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 12 }, ...over,
});

const call = async (ctx: AgentContext, name: string, args: Record<string, unknown> = {}) =>
  buildTools(ctx).executeToolCall({ function: { name, arguments: args } });

/** Replies with one tool call per step, then plain text; records every request it got. */
function scripted(steps: Array<[string, Record<string, unknown>] | string>): AgentChatClient {
  return {
    chat: async () => {
      const step = steps.shift() ?? 'done';
      if (typeof step === 'string') return { message: { role: 'assistant' as const, content: step } };
      return { message: { role: 'assistant' as const, content: '', tool_calls: [{ function: { name: step[0], arguments: step[1] } }] } };
    },
  };
}

describe('campaign agent session', () => {
  it('drafts, evaluates on train/validation only, reuses a cached evaluation and shortlists, all within the campaign', async () => {
    await withContext(async (ctx) => {
      const client = scripted([
        ['list_specs', {}], ['draft_spec', draftArgs()], ['evaluate_draft', { id: 'LLM-TEST-BREAKOUT-1' }],
        ['evaluate_draft', { id: 'LLM-TEST-BREAKOUT-1' }], ['shortlist_spec', { id: 'LLM-TEST-BREAKOUT-1', rationale: 'validation positive on both symbols in this test' }],
        'Session report: one draft, evaluated, shortlisted.',
      ]);
      const report = await runCampaignAgent(ctx, client, 'scripted');
      assert.equal(report.error, null);
      assert.match(report.finalText ?? '', /Session report/);
      const spec = JSON.parse(readFileSync(path.join(ctx.proposedDir, 'LLM-TEST-BREAKOUT-1.json'), 'utf8')) as HypothesisSpec;
      assert.equal(spec.status, 'DRAFT');
      assert.equal(spec.campaign, 'TEST-CAMPAIGN');
      assert.deepEqual(spec.window, { days: 400, endDaysAgo: 0, endIso: '2026-01-01T00:00:00.000Z', split: CAMPAIGN.window.split });
      assert.equal(spec.evidence.alpha, 0.05);
      assert.deepEqual(readJournal(ctx.journalFile).map((e) => e.kind), ['draft', 'evaluation', 'shortlist']);
      const evaluation = report.turns.flatMap((t) => t.toolResults ?? []).find((r) => r.toolName === 'evaluate_draft');
      assert.ok(evaluation?.success);
      assert.doesNotMatch(evaluation.outputString, /"test"/);
      assert.match(evaluation.outputString, /"validation":\{"trades":\d+/);
      assert.equal(existsSync(ctx.ledgerFile), false);
    });
  });

  it('reports a stuck loop as an error with the turns so far, instead of throwing', async () => {
    await withContext(async (ctx) => {
      const report = await runCampaignAgent(ctx, scripted([['list_specs', {}], ['list_specs', {}], ['list_specs', {}], ['list_specs', {}]]), 'scripted');
      assert.match(report.error ?? '', /ToolLoop|repeated/i);
      assert.ok(report.turns.length >= 2);
    });
  });
});

describe('campaign agent tools', () => {
  it('rejects drafts outside the campaign or the proposal rules', async () => {
    await withContext(async (ctx) => {
      assert.match((await call(ctx, 'draft_spec', draftArgs({ symbols: ['XRPUSDT'] }))).outputString, /symbols outside the campaign: XRPUSDT/);
      assert.match((await call(ctx, 'draft_spec', draftArgs({ timeframes: ['4h'] }))).outputString, /timeframes outside the campaign: 4h/);
      assert.match((await call(ctx, 'draft_spec', draftArgs({ id: 'NO-PREFIX' }))).outputString, /must start with LLM-/);
      assert.match((await call(ctx, 'draft_spec', draftArgs({ roundTripBps: 2 }))).outputString, /roundTripBps 2 < 10/);
      assert.ok((await call(ctx, 'draft_spec', draftArgs())).success);
      assert.match((await call(ctx, 'draft_spec', draftArgs())).outputString, /already exists/);
    });
  });

  it('evaluates only campaign DRAFTs in the campaign window, within the evaluation budget', async () => {
    await withContext(async (ctx) => {
      const handWritten = parseSpec({ ...JSON.parse(JSON.stringify(draftSpecFile(ctx))), id: 'HAND-SPEC', campaign: undefined }, 'test');
      writeFileSync(path.join(ctx.specsDir, 'HAND-SPEC.json'), JSON.stringify(handWritten));
      assert.match((await call(ctx, 'evaluate_draft', { id: 'HAND-SPEC' })).outputString, /not a TEST-CAMPAIGN spec/);
      assert.match((await call(ctx, 'evaluate_draft', { id: 'LLM-NOPE' })).outputString, /unknown spec id/);
      writeFileSync(path.join(ctx.proposedDir, 'LLM-WIDE.json'), JSON.stringify({ ...draftSpecFile(ctx), id: 'LLM-WIDE', window: { ...draftSpecFile(ctx).window, endIso: '2026-06-01T00:00:00.000Z' } }));
      assert.match((await call(ctx, 'evaluate_draft', { id: 'LLM-WIDE' })).outputString, /window must be the campaign window/);
      writeFileSync(path.join(ctx.proposedDir, 'LLM-REG.json'), JSON.stringify({ ...draftSpecFile(ctx), id: 'LLM-REG', status: 'REGISTERED' }));
      assert.match((await call(ctx, 'evaluate_draft', { id: 'LLM-REG' })).outputString, /is REGISTERED/);
      for (const id of ['LLM-A-1', 'LLM-B-1']) {
        assert.ok((await call(ctx, 'draft_spec', draftArgs({ id }))).success);
        assert.ok((await call(ctx, 'evaluate_draft', { id })).success);
      }
      assert.ok((await call(ctx, 'draft_spec', draftArgs({ id: 'LLM-C-1' }))).success);
      assert.match((await call(ctx, 'evaluate_draft', { id: 'LLM-C-1' })).outputString, /budget spent \(2\/2\)/);
      assert.ok((await call(ctx, 'evaluate_draft', { id: 'LLM-A-1' })).success, 'a cached evaluation costs nothing');
    });
  });

  it('shortlists only evaluated drafts, once each, within the registration budget', async () => {
    await withContext(async (ctx) => {
      const rationale = 'validation evidence positive in this fixture';
      for (const id of ['LLM-A-1', 'LLM-B-1']) await call(ctx, 'draft_spec', draftArgs({ id }));
      assert.match((await call(ctx, 'shortlist_spec', { id: 'LLM-A-1', rationale })).outputString, /no evaluation yet/);
      await call(ctx, 'evaluate_draft', { id: 'LLM-A-1' });
      await call(ctx, 'evaluate_draft', { id: 'LLM-B-1' });
      assert.ok((await call(ctx, 'shortlist_spec', { id: 'LLM-A-1', rationale })).success);
      assert.match((await call(ctx, 'shortlist_spec', { id: 'LLM-A-1', rationale })).outputString, /already shortlisted/);
      assert.match((await call(ctx, 'shortlist_spec', { id: 'LLM-B-1', rationale })).outputString, /no shortlist slots left \(1\/1\)/);
    });
  });
});

/** A valid campaign DRAFT as stored on disk, for tests that write variants of it directly. */
function draftSpecFile(ctx: AgentContext): HypothesisSpec {
  return parseSpec({
    schemaVersion: 1, id: 'LLM-FIXTURE', version: 1, status: 'DRAFT', hypothesis: 'fixture hypothesis for direct writes', family: 'DONCHIAN_BREAKOUT',
    symbols: ['SOLUSDT'], timeframes: ['1h'], timeframeRule: 'each timeframe tested independently',
    context: { id: 'EMA50_GT_EMA200_ATR14_Q33_TRAIN', taxonomyVersion: 'ctx-v1' }, campaign: ctx.campaign.id,
    params: { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 12 },
    window: { days: 400, endDaysAgo: 0, endIso: '2026-01-01T00:00:00.000Z', split: CAMPAIGN.window.split },
    costs: { roundTripBps: 15 }, evidence: { minOosTrades: 100, alpha: 0.05 },
  }, 'fixture');
}

describe('registrationProblems', () => {
  const registered = (over: Record<string, unknown> = {}): HypothesisSpec => parseSpec({
    schemaVersion: 1, id: 'LLM-REG-1', version: 1, status: 'REGISTERED', hypothesis: 'registered fixture hypothesis', family: 'DONCHIAN_BREAKOUT',
    symbols: ['SOLUSDT'], timeframes: ['1h'], timeframeRule: 'each timeframe tested independently',
    context: { id: 'EMA50_GT_EMA200_ATR14_Q33_TRAIN', taxonomyVersion: 'ctx-v1' }, campaign: 'TEST-CAMPAIGN',
    params: { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 12 },
    window: { days: 400, endDaysAgo: 0, endIso: '2026-01-01T00:00:00.000Z', split: CAMPAIGN.window.split },
    costs: { roundTripBps: 15 }, evidence: { minOosTrades: 100, alpha: 0.05 }, ...over,
  }, 'fixture');
  const read = (specId: string): OosRead => ({
    specId, specVersion: 1, specHash: 'h', symbol: 'SOLUSDT', timeframe: '1h', testFromIso: '2025-10-01T00:00:00.000Z',
    testToIso: '2026-01-01T00:00:00.000Z', readAtIso: '2026-01-02T00:00:00.000Z', runId: 'r', campaign: 'TEST-CAMPAIGN',
  });

  it('accepts a spec in the campaign window, at the per-spec alpha, within budget', () => {
    const spec = registered();
    assert.deepEqual(registrationProblems(spec, CAMPAIGN, [spec], []), []);
  });

  it('refuses another window, a looser alpha, or a spec past the registration budget', () => {
    const shifted = registered({ window: { days: 300, endDaysAgo: 0, endIso: '2026-01-01T00:00:00.000Z', split: CAMPAIGN.window.split } });
    assert.match(registrationProblems(shifted, CAMPAIGN, [shifted], []).join(), /campaign window/);
    const twoSpecCampaign = { ...CAMPAIGN, maxRegistrations: 2 };
    assert.match(registrationProblems(registered(), twoSpecCampaign, [registered()], []).join(), /alpha 0.05 exceeds the campaign's per-spec alpha 0.025/);
    const second = registered({ id: 'LLM-REG-2' });
    assert.match(registrationProblems(second, CAMPAIGN, [registered(), second], []).join(), /2 registered specs, budget 1/);
  });

  it('keeps counting a registration after its spec file is deleted, through its ledger reads', () => {
    const spec = registered({ id: 'LLM-REG-2' });
    assert.match(registrationProblems(spec, CAMPAIGN, [spec], [read('LLM-REG-1')]).join(), /2 registered specs, budget 1/);
  });
});
