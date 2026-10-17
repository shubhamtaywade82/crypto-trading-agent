import assert from 'node:assert/strict';
import { test } from 'node:test';

// Each case re-imports config.ts fresh under mutated env, mirroring tests/config.coindcx.test.ts.
async function loadConfig(env: Record<string, string>) {
  const prior = { ...process.env };
  Object.assign(process.env, { MODE: 'paper', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's', ...env });
  try {
    return await import(`../src/config.js?t=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = prior;
  }
}

test('council auto-trade is off by default and carries no probability floor', async () => {
  const { config } = await loadConfig({});
  assert.equal(config.llmCouncil.autoTrade, false);
  assert.equal('minProbability' in config.llmCouncil, false);
});

test('LLM_COUNCIL_AUTOTRADE=on is refused until the expectancy gate exists', async () => {
  await assert.rejects(loadConfig({ LLM_COUNCIL_AUTOTRADE: 'on' }), /LLM_COUNCIL_AUTOTRADE=on is refused/);
});

test('live entries are cancelled after 120 s unfilled by default, and the TTL is bounded', async () => {
  const { config } = await loadConfig({});
  assert.equal(config.entryOrderTtlMs, 120_000);
  await assert.rejects(loadConfig({ ENTRY_ORDER_TTL_MS: '5000' }));
  await assert.rejects(loadConfig({ ENTRY_ORDER_TTL_MS: '901000' }));
});
