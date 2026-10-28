import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HypothesisRegistry,
  validateConditions,
  anonymizeForResearch,
  type DeclarativeHypothesis,
} from '../src/research/HypothesisRegistry.js';

test('HypothesisRegistry: validates feature condition whitelist', () => {
  // Valid condition using whitelisted feature
  const valid = validateConditions([
    { feature: 'absorption_score', operator: 'gte', value: 0.7 },
    { feature: 'sweep_depth_atr', operator: 'gte', value: 1.2 },
  ]);
  assert.equal(valid, true);

  // Invalid feature name rejected
  const invalid = validateConditions([
    // @ts-expect-error test invalid feature
    { feature: 'unsupported_magic_indicator', operator: 'gte', value: 10 },
  ]);
  assert.equal(invalid, false);
});

test('HypothesisRegistry: manages immutable lifecycle transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyp-reg-'));
  const file = join(dir, 'hypotheses.jsonl');

  try {
    const registry = new HypothesisRegistry(file);

    const hypInput: Omit<DeclarativeHypothesis, 'status' | 'history'> = {
      id: 'hyp-101',
      title: 'Absorption with deep sweep in ranging regimes',
      rationale: 'High absorption following deep liquidity sweeps shows stronger reversal expectancy',
      dataCutoff: '2026-10-28T00:00:00Z',
      createdAt: Date.now(),
      population: {
        instrumentGroup: 'perpetual_futures',
        direction: 'long',
        regime: 'RANGE',
      },
      conditions: [{ feature: 'absorption_score', operator: 'gte', value: 0.75 }],
      baseline: 'stratified_random_entries',
      primaryMetric: 'net_expectancy_r',
      requiredEvaluation: 'purged_walk_forward',
    };

    const registered = registry.register(hypInput);
    assert.equal(registered.status, 'REGISTERED');

    // Transition to TESTING
    const testing = registry.transition('hyp-101', 'TESTING');
    assert.equal(testing.status, 'TESTING');

    // Transition to VALIDATED
    const validated = registry.transition('hyp-101', 'VALIDATED');
    assert.equal(validated.status, 'VALIDATED');

    // Illegal transition: Cannot jump from VALIDATED directly to PROMOTED without PAPER_CHALLENGER
    assert.throws(() => {
      registry.transition('hyp-101', 'PROMOTED');
    }, /Illegal hypothesis transition/);

    // Valid transition to PAPER_CHALLENGER then PROMOTED
    registry.transition('hyp-101', 'PAPER_CHALLENGER');
    const promoted = registry.transition('hyp-101', 'PROMOTED');
    assert.equal(promoted.status, 'PROMOTED');

    // Terminal: Cannot transition out of PROMOTED
    assert.throws(() => {
      registry.transition('hyp-101', 'TESTING');
    }, /Illegal hypothesis transition/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HypothesisRegistry: anonymizes symbols and calendar dates for LLM research', () => {
  const diagnostics = `
    Analysis for BTCUSDT and ETHUSDT:
    During crash on 2022-11-08, BTCUSDT dropped 15% with high volume.
    On 2024-03-05, ETHUSDT broke resistance.
  `;

  const { anonymizedText, symbolMap } = anonymizeForResearch({
    symbols: ['BTCUSDT', 'ETHUSDT'],
    diagnostics,
  });

  assert.equal(symbolMap.get('BTCUSDT'), 'ASSET_A');
  assert.equal(symbolMap.get('ETHUSDT'), 'ASSET_B');

  assert.ok(!anonymizedText.includes('BTCUSDT'));
  assert.ok(!anonymizedText.includes('ETHUSDT'));
  assert.ok(anonymizedText.includes('ASSET_A'));
  assert.ok(anonymizedText.includes('ASSET_B'));

  // Calendar dates must be masked
  assert.ok(!anonymizedText.includes('2022-11-08'));
  assert.ok(!anonymizedText.includes('2024-03-05'));
  assert.ok(anonymizedText.includes('PERIOD_T'));
});
