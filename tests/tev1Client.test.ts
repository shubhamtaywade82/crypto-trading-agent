import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpTev1Client, Tev1ClientError, type FetchLike } from '../src/decision-intelligence/clients/tev1Client.js';
import type { SystemoneRequest } from '../src/decision-intelligence/types.js';

const request: SystemoneRequest = {
  model: 'tev1:4b',
  state: { symbol: 'SOLUSDT', setup: { side: 'LONG' } },
  questions: {
    trade_decision: {
      type: 'choice',
      instructions: 'Evaluate the LONG candidate.',
      criteria: { APPROVE: 'Evidence satisfies the criteria.', WAIT: 'Confirmation missing.', NO_TRADE: 'Conflict.', INSUFFICIENT_DATA: 'Evidence unusable.' },
    },
  },
};

const okResponse = {
  model: 'tev1:4b',
  answers: {
    trade_decision: { type: 'choice', choice: 'APPROVE', probabilities: { APPROVE: 0.82, WAIT: 0.12, NO_TRADE: 0.04, INSUFFICIENT_DATA: 0.02 }, confidence: 0.82 },
  },
  usage: { input_tokens: 841, output_tokens: 4 },
};

/** Captures what the client put on the wire and answers with a scripted reply (the documented happy-path shape by default). */
function fakeFetch(reply: (captured: { body: any; status: number }) => Response | Promise<Response> = () => Response.json(okResponse)) {
  const seen: { url: string; init: RequestInit; body: any }[] = [];
  const impl: FetchLike = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(String(init.body)) });
    return await reply({ body: seen[seen.length - 1].body, status: 200 });
  };
  return { seen, impl };
}

// ─── Happy path ───

test('posts to /v1/systemone with the model, state and questions, and returns the parsed answers', async () => {
  const { seen, impl } = fakeFetch();
  const client = new HttpTev1Client({ host: 'http://127.0.0.1:11434', timeoutMs: 1000, fetchImpl: impl });
  const response = await client.systemone(request);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:11434/v1/systemone');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].body.model, 'tev1:4b');
  assert.deepEqual(seen[0].body.questions.trade_decision.criteria, request.questions.trade_decision.criteria);
  assert.equal(response.answers.trade_decision?.type, 'choice');
  assert.equal((response.answers.trade_decision as { choice: string }).choice, 'APPROVE');
});

test('sends a Bearer token only when an API key is configured', async () => {
  const withKey = fakeFetch();
  await new HttpTev1Client({ host: 'http://cloud', apiKey: ' k1 ', timeoutMs: 1000, fetchImpl: withKey.impl }).systemone(request);
  assert.equal((withKey.seen[0].init.headers as Record<string, string>).Authorization, 'Bearer k1');

  const withoutKey = fakeFetch();
  await new HttpTev1Client({ host: 'http://127.0.0.1:11434', timeoutMs: 1000, fetchImpl: withoutKey.impl }).systemone(request);
  assert.equal((withoutKey.seen[0].init.headers as Record<string, string>).Authorization, undefined);
});

test('a trailing slash on the host does not produce a double slash in the URL', async () => {
  const { seen, impl } = fakeFetch();
  await new HttpTev1Client({ host: 'http://127.0.0.1:11434/', timeoutMs: 1000, fetchImpl: impl }).systemone(request);
  assert.equal(seen[0].url, 'http://127.0.0.1:11434/v1/systemone');
});

// ─── Failure modes: every one is a typed Tev1ClientError, never prose ───

test('an HTTP error surfaces as kind=http with the status and a truncated body', async () => {
  const client = new HttpTev1Client({
    host: 'http://127.0.0.1:11434',
    timeoutMs: 1000,
    fetchImpl: async () => new Response('model not found '.repeat(50), { status: 404 }),
  });
  await assert.rejects(client.systemone(request), (err: unknown) => {
    assert.ok(err instanceof Tev1ClientError);
    assert.equal(err.kind, 'http');
    assert.equal(err.status, 404);
    assert.ok(err.message.length < 300, 'body must be truncated');
    return true;
  });
});

test('a transport failure surfaces as kind=network', async () => {
  const client = new HttpTev1Client({
    host: 'http://127.0.0.1:11434',
    timeoutMs: 1000,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(client.systemone(request), (err: unknown) => {
    assert.ok(err instanceof Tev1ClientError);
    assert.equal(err.kind, 'network');
    return true;
  });
});

test('a request that exceeds the timeout aborts as kind=timeout', async () => {
  const client = new HttpTev1Client({
    host: 'http://127.0.0.1:11434',
    timeoutMs: 25,
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        // Simulate a hung server: honor the AbortSignal like real fetch does.
        init.signal?.addEventListener('abort', () => {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  });
  await assert.rejects(client.systemone(request), (err: unknown) => {
    assert.ok(err instanceof Tev1ClientError);
    assert.equal(err.kind, 'timeout');
    return true;
  });
});

test('a non-JSON body surfaces as kind=invalid_response', async () => {
  const client = new HttpTev1Client({
    host: 'http://127.0.0.1:11434',
    timeoutMs: 1000,
    fetchImpl: async () => new Response('<html>gateway error</html>', { status: 200 }),
  });
  await assert.rejects(client.systemone(request), (err: unknown) => {
    assert.ok(err instanceof Tev1ClientError);
    assert.equal(err.kind, 'invalid_response');
    return true;
  });
});

test('a JSON body without an answers object surfaces as kind=invalid_response', async () => {
  for (const body of [null, 42, 'ok', { model: 'tev1:4b' }, { answers: [] }]) {
    const client = new HttpTev1Client({
      host: 'http://127.0.0.1:11434',
      timeoutMs: 1000,
      fetchImpl: async () => Response.json(body),
    });
    await assert.rejects(client.systemone(request), (err: unknown) => {
      assert.ok(err instanceof Tev1ClientError);
      assert.equal(err.kind, 'invalid_response');
      return true;
    });
  }
});

// ─── Wire test against a real loopback server (the ollamaSdkWire precedent) ───

test('against a live loopback server the full request/response round-trips', async () => {
  const { createServer } = await import('node:http');
  const recorded: { path: string; auth: string | undefined; body: any }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      recorded.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(okResponse));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  try {
    const client = new HttpTev1Client({ host: `http://127.0.0.1:${address.port}`, apiKey: 'wire-key', timeoutMs: 2000 });
    const response = await client.systemone(request);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].path, '/v1/systemone');
    assert.equal(recorded[0].auth, 'Bearer wire-key');
    assert.equal(recorded[0].body.state.setup.side, 'LONG');
    assert.equal(response.answers.trade_decision?.type, 'choice');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('against a loopback server that hangs, the timeout aborts the request', async () => {
  const { createServer } = await import('node:http');
  const server = createServer(() => {
    /* never respond */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  try {
    const client = new HttpTev1Client({ host: `http://127.0.0.1:${address.port}`, timeoutMs: 50 });
    const started = Date.now();
    await assert.rejects(client.systemone(request), (err: unknown) => {
      assert.ok(err instanceof Tev1ClientError);
      assert.equal(err.kind, 'timeout');
      return true;
    });
    assert.ok(Date.now() - started < 2000, 'must fail fast, not stall the loop');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
