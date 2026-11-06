import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseSpec } from '../src/research/pipeline/hypothesis.js';
import { proposeSpecs, writeProposals, type LlmClient } from '../src/research/pipeline/propose.js';

const draft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1, id: 'LLM-COMPRESSION-BREAKOUT-V1', version: 1, status: 'DRAFT',
  hypothesis: 'Compressed ranges in a bullish low-volatility regime precede expansion as resting stops above the range fill.',
  family: 'DONCHIAN_BREAKOUT', symbols: ['SOLUSDT'], timeframes: ['1h'], timeframeRule: 'each timeframe independently',
  context: { id: 'EMA50_GT_EMA200_ATR14_Q33_TRAIN', taxonomyVersion: 'ctx-v1' },
  params: { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 12 },
  window: { days: 730, endDaysAgo: 0, split: { trainPct: 60, validationPct: 20, testPct: 20 } },
  costs: { roundTripBps: 15 }, evidence: { minOosTrades: 100, alpha: 0.05 }, ...over,
});

/** Replies in order and records every prompt it was sent. */
function scripted(replies: string[]): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, generateText: async ({ prompt }) => { prompts.push(prompt); return replies.shift() ?? '{"proposals":[]}'; } };
}
const reply = (...specs: Array<Record<string, unknown>>): string => JSON.stringify({ proposals: specs });

describe('proposeSpecs', () => {
  it('forces DRAFT and strips a fixed window end, so a proposal can never read a test window', async () => {
    const client = scripted([reply(draft({ status: 'REGISTERED', version: 7, window: { ...(draft().window as object), endIso: '2026-10-01T00:00:00.000Z' } }))]);
    const { proposals } = await proposeSpecs({ client, model: 'm', count: 1, existing: [] });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.status, 'DRAFT');
    assert.equal(proposals[0]!.version, 1);
    assert.equal(proposals[0]!.window.endIso, undefined);
  });

  it('rejects drafts outside the evaluator and policy limits, then repairs them once with the reasons', async () => {
    const bad = [
      draft({ id: 'LLM-A', family: 'MEAN_REVERSION' }),
      draft({ id: 'LLM-B', symbols: ['DOGEUSDT'] }),
      draft({ id: 'LLM-C', costs: { roundTripBps: 2 } }),
      draft({ id: 'LLM-D', evidence: { minOosTrades: 20, alpha: 0.05 } }),
      draft({ id: 'NOPREFIX' }),
    ];
    const client = scripted([reply(...bad), reply(draft({ id: 'LLM-FIXED' }))]);
    const result = await proposeSpecs({ client, model: 'm', count: 5, existing: [] });
    assert.deepEqual(result.proposals.map((p) => p.id), ['LLM-FIXED']);
    assert.equal(result.rejected.length, 5);
    assert.match(client.prompts[1]!, /MEAN_REVERSION[\s\S]*DOGEUSDT[\s\S]*roundTripBps 2[\s\S]*minOosTrades 20[\s\S]*must start with LLM-/);
  });

  it('refuses an id already on disk and an id repeated within one reply', async () => {
    const existing = [parseSpec(draft({ id: 'LLM-TAKEN' }), 'disk')];
    const client = scripted([reply(draft({ id: 'LLM-TAKEN' }), draft({ id: 'LLM-NEW' }), draft({ id: 'LLM-NEW' }))]);
    const result = await proposeSpecs({ client, model: 'm', count: 3, existing });
    assert.deepEqual(result.proposals.map((p) => p.id), ['LLM-NEW']);
    assert.match(client.prompts[0]!, /LLM-TAKEN@1: Compressed ranges/);
  });

  it('retries once after an unreadable reply, and lets transport errors reach the caller', async () => {
    const client = scripted(['not json at all', reply(draft())]);
    const result = await proposeSpecs({ client, model: 'm', count: 1, existing: [] });
    assert.equal(result.proposals.length, 1);
    assert.match(client.prompts[1]!, /invalid JSON/);
    const down: LlmClient = { generateText: async () => { throw new Error('ECONNREFUSED'); } };
    await assert.rejects(proposeSpecs({ client: down, model: 'm', count: 1, existing: [] }), /ECONNREFUSED/);
  });
});

describe('writeProposals', () => {
  it('writes one file per proposal and never overwrites an existing one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'proposed-'));
    try {
      const kept = path.join(dir, 'LLM-COMPRESSION-BREAKOUT-V1.json');
      writeFileSync(kept, 'hand-edited');
      const written = writeProposals([parseSpec(draft(), 'a'), parseSpec(draft({ id: 'LLM-OTHER' }), 'b')], dir);
      assert.deepEqual(written, [path.join(dir, 'LLM-OTHER.json')]);
      assert.equal(readFileSync(kept, 'utf8'), 'hand-edited');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
