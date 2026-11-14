import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPaperExchangeOnly } from '../src/runtime/paperExchangeOnly.js';

const valid = {
  mode: 'paper',
  binanceTestnet: false,
  paperExchange: {
    url: 'http://127.0.0.1:3100',
    accountId: 'crypto-agent-paper',
    apiKey: 'operator-token',
  },
};

test('allows the dedicated runner only when PaperExchange is configured', () => {
  assert.doesNotThrow(() => assertPaperExchangeOnly(valid));
});

test('refuses live mode even when PaperExchange credentials are present', () => {
  assert.throws(
    () => assertPaperExchangeOnly({ ...valid, mode: 'live' }),
    /requires MODE=paper/,
  );
});

test('refuses the local in-memory paper fallback', () => {
  assert.throws(
    () => assertPaperExchangeOnly({ ...valid, paperExchange: null }),
    /PAPER_EXCHANGE_URL and PAPER_EXCHANGE_ACCOUNT_ID/,
  );
});

test('refuses missing PaperExchange API credentials', () => {
  assert.throws(
    () => assertPaperExchangeOnly({
      ...valid,
      paperExchange: { ...valid.paperExchange, apiKey: '   ' },
    }),
    /PAPER_EXCHANGE_API_KEY/,
  );
});

test('refuses Binance testnet in the PaperExchange-only runner', () => {
  assert.throws(
    () => assertPaperExchangeOnly({ ...valid, binanceTestnet: true }),
    /BINANCE_TESTNET=off/,
  );

  assert.throws(
    () => assertPaperExchangeOnly({
      ...valid,
      binanceTestnet: false,
      paperExchange: { ...valid.paperExchange, url: '   ' },
    }),
    /PAPER_EXCHANGE_URL/,
  );
});
