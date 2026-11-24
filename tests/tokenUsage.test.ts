import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installTokenUsageLog, usageFromBody, type TokenUsageRecord } from '../src/ollama/tokenUsage.js';

test('usageFromBody reads a plain reply and the final line of a stream; a reply without counts is null', () => {
  assert.deepEqual(usageFromBody('{"model":"beam","response":"x","prompt_eval_count":412,"eval_count":83}'), { model: 'beam', promptTokens: 412, outputTokens: 83 });
  const stream = '{"model":"beam","response":"a"}\n{"model":"beam","done":true,"prompt_eval_count":10,"eval_count":2}\n';
  assert.deepEqual(usageFromBody(stream), { model: 'beam', promptTokens: 10, outputTokens: 2 });
  assert.equal(usageFromBody('{"error":"Add usage credits"}'), null);
  assert.equal(usageFromBody('not json'), null);
});

test('the fetch wrapper records LLM calls with their source and passes every response through untouched', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'llm-usage-')), 'usage.jsonl');
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const isLlm = String(input).endsWith('/api/generate');
    return new Response(isLlm ? '{"model":"qwen3.5:4b","response":"{}","prompt_eval_count":410,"eval_count":98}' : '{"models":[]}', { status: 200 });
  }) as typeof fetch;
  try {
    installTokenUsageLog('fleet', file);
    const reply = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: '{}' });
    assert.equal((await reply.json() as { eval_count: number }).eval_count, 98, 'the caller still reads the body');
    await fetch('http://127.0.0.1:11434/api/tags');
    await new Promise((r) => setTimeout(r, 20));

    const records = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TokenUsageRecord);
    assert.equal(records.length, 1, 'only generate/chat calls are recorded');
    assert.deepEqual(
      [records[0]!.source, records[0]!.host, records[0]!.endpoint, records[0]!.model, records[0]!.promptTokens, records[0]!.outputTokens, records[0]!.status],
      ['fleet', '127.0.0.1:11434', 'generate', 'qwen3.5:4b', 410, 98, 200],
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(existsSync(file));
});
