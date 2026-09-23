import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvSchema } from '../src/config.js';

test('MarketState V1 is enabled by default as a read-only feature', () => {
  assert.equal(EnvSchema.parse({}).MARKET_STATE_V1, 'on');
  assert.equal(EnvSchema.parse({ MARKET_STATE_V1: 'off' }).MARKET_STATE_V1, 'off');
});
