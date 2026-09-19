import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVerdict } from '../src/ollama/advisor.js';

test('should return VETO with the model reason', () => {
  assert.deepEqual(parseVerdict('{"verdict":"VETO","reason":"extended entry"}'), { verdict: 'VETO', reason: 'extended entry' });
});

test('should proceed on an explicit PROCEED', () => {
  assert.equal(parseVerdict('{"verdict":"PROCEED","reason":"clean"}').verdict, 'PROCEED');
});

test('should proceed when the reply is not JSON or has an unknown verdict', () => {
  assert.equal(parseVerdict('sure, go ahead').verdict, 'PROCEED');
  assert.ok(parseVerdict('sure, go ahead').reason.startsWith('advisor'));
  assert.equal(parseVerdict('{"verdict":"MAYBE"}').verdict, 'PROCEED');
});
