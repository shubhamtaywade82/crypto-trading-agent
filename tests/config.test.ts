import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvSchema } from '../src/config.js';

const URL = 'http://127.0.0.1:3100';

test('should refuse a remote paper exchange without an explicit account id, naming the variable', () => {
  for (const env of [{ PAPER_EXCHANGE_URL: URL }, { PAPER_EXCHANGE_URL: URL, PAPER_EXCHANGE_ACCOUNT_ID: '  ' }]) {
    const result = EnvSchema.safeParse(env);
    assert.ok(!result.success);
    assert.deepEqual(result.error.issues.map((issue) => issue.path.join('.')), ['PAPER_EXCHANGE_ACCOUNT_ID']);
    assert.match(result.error.issues[0].message, /PAPER_EXCHANGE_ACCOUNT_ID.*PAPER_EXCHANGE_URL/);
  }
});

test('should accept a remote paper exchange with an account id and keep the id as given', () => {
  assert.equal(EnvSchema.parse({ PAPER_EXCHANGE_URL: URL, PAPER_EXCHANGE_ACCOUNT_ID: 'crypto-agent' }).PAPER_EXCHANGE_ACCOUNT_ID, 'crypto-agent');
});

test('should not need an account id for local paper or live mode', () => {
  assert.ok(EnvSchema.safeParse({}).success);
  assert.ok(EnvSchema.safeParse({ MODE: 'live', PAPER_EXCHANGE_URL: URL }).success);
});
