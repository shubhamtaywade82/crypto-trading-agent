import assert from 'node:assert/strict';
import { test } from 'node:test';

// Each case re-imports config.ts fresh under mutated env, mirroring tests/config.test.ts's existing pattern.
async function loadConfig(env: Record<string, string>) {
  const prior = { ...process.env };
  Object.assign(process.env, {
    MODE: 'paper',
    BINANCE_API_KEY: 'k',
    BINANCE_API_SECRET: 's',
    COINDCX_API_KEY: '',
    COINDCX_API_SECRET: '',
    ALERT_ONLY: 'off',
    ...env,
  });
  try {
    return await import(`../src/config.js?t=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = prior;
  }
}

// MODE=live trades Binance only. CoinDCX credentials are refused in live mode: a CoinDCX broker would take the live
// path and skip the Binance guards (journal, startup reconciliation, entry tracker), so they cannot be set alongside it.
test('MODE=live without CoinDCX credentials starts on Binance credentials alone', async () => {
  const { config } = await loadConfig({ MODE: 'live' });
  assert.equal(config.coindcx?.apiKey, '');
  assert.equal(config.coindcx?.apiSecret, '');
});

test('MODE=live refuses CoinDCX credentials instead of routing live orders around the Binance guards', async () => {
  await assert.rejects(loadConfig({ MODE: 'live', COINDCX_API_KEY: 'a', COINDCX_API_SECRET: 'b' }), /Unset COINDCX_API_KEY/);
  await assert.rejects(loadConfig({ MODE: 'live', COINDCX_API_SECRET: 'b' }), /Unset COINDCX_API_KEY/);
});

test('MODE=live requires Binance credentials even when CoinDCX ones are present', async () => {
  await assert.rejects(loadConfig({ MODE: 'live', BINANCE_API_KEY: '', BINANCE_API_SECRET: '' }), /LIVE mode requires BINANCE_API_KEY/);
});

test('MODE=paper never requires CoinDCX credentials, config.coindcx is null', async () => {
  const { config } = await loadConfig({});
  assert.equal(config.coindcx, null);
});

test('ALERT_ONLY=on sets config.alertOnly true', async () => {
  const { config } = await loadConfig({ MODE: 'live', ALERT_ONLY: 'on' });
  assert.equal(config.alertOnly, true);
});

test('ALERT_ONLY defaults to off', async () => {
  const { config } = await loadConfig({});
  assert.equal(config.alertOnly, false);
});
