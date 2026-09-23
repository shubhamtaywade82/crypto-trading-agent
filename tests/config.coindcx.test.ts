import assert from 'node:assert/strict';
import { test } from 'node:test';

// Each case re-imports config.ts fresh under mutated env, mirroring tests/config.test.ts's existing pattern.
async function loadConfig(env: Record<string, string>) {
  const prior = { ...process.env };
  Object.assign(process.env, { MODE: 'paper', BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's', ...env });
  try {
    return await import(`../src/config.js?t=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = prior;
  }
}

test('MODE=live without CoinDCX credentials refuses to start', async () => {
  await assert.rejects(
    () => loadConfig({ MODE: 'live' }),
    /LIVE mode requires COINDCX_API_KEY and COINDCX_API_SECRET/
  );
});

test('MODE=live with CoinDCX credentials builds config.coindcx', async () => {
  const { config } = await loadConfig({ MODE: 'live', COINDCX_API_KEY: 'a', COINDCX_API_SECRET: 'b' });
  assert.equal(config.coindcx?.apiKey, 'a');
  assert.equal(config.coindcx?.paperMode, true); // default 'on'
  assert.equal(config.coindcx?.quotePreference, 'auto');
  assert.equal(config.coindcx?.initialBalance, 1_150);
});

test('MODE=paper never requires CoinDCX credentials, config.coindcx is null', async () => {
  const { config } = await loadConfig({});
  assert.equal(config.coindcx, null);
});

test('COINDCX_PAPER_MODE=off is honored', async () => {
  const { config } = await loadConfig({ MODE: 'live', COINDCX_API_KEY: 'a', COINDCX_API_SECRET: 'b', COINDCX_PAPER_MODE: 'off' });
  assert.equal(config.coindcx?.paperMode, false);
});
