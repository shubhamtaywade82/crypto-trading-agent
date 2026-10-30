import assert from 'node:assert/strict';
import { test } from 'node:test';

// Each case re-imports config.ts fresh under mutated env, mirroring tests/config.entry.test.ts.
async function loadConfig(env: Record<string, string>) {
  const prior = { ...process.env };
  Object.assign(process.env, { MODE: 'paper', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's', ...env });
  try {
    return await import(`../src/config.js?t=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = prior;
  }
}

test('the Tev1 gate defaults to off, with the 4b baseline model and a fail-fast budget', async () => {
  const { config } = await loadConfig({});
  assert.equal(config.tev1.gate, 'off');
  assert.equal(config.tev1.model, 'tev1:4b');
  assert.equal(config.tev1.timeoutMs, 8000);
  assert.equal(config.tev1.minConfidence, 0.6);
  assert.equal(config.tev1.auditPath, 'data/tev1-decisions.jsonl');
});

test('shadow and enforced modes parse, and the knobs are bounded', async () => {
  const shadow = await loadConfig({ TEV1_GATE: 'shadow' });
  assert.equal(shadow.config.tev1.gate, 'shadow');
  const on = await loadConfig({ TEV1_GATE: 'on' });
  assert.equal(on.config.tev1.gate, 'on');

  await assert.rejects(loadConfig({ TEV1_GATE: 'sometimes' }));
  await assert.rejects(loadConfig({ TEV1_TIMEOUT_MS: '0' }));
  await assert.rejects(loadConfig({ TEV1_MIN_CONFIDENCE: '1.5' }));
});

test('TEV1_GATE=on is refused in live mode until out-of-sample evidence exists', async () => {
  await assert.rejects(loadConfig({ MODE: 'live', TEV1_GATE: 'on' }), /TEV1_GATE=on is refused in MODE=live/);
  // shadow stays available in live: evaluate and audit, refuse nothing.
  const liveShadow = await loadConfig({ MODE: 'live', TEV1_GATE: 'shadow' });
  assert.equal(liveShadow.config.tev1.gate, 'shadow');
});
