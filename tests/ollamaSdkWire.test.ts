import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { OllamaClient, OllamaUnsupportedCapabilityError } from '@nemesis-oss/ollama-sdk';
import { OllamaAdvisor } from '../src/ollama/advisor.js';
import { config } from '../src/config.js';
import { SmcExecutionAdvisor } from '../src/strategies/smc-ml/SmcExecutionAdvisor.js';
import { SmcMlRuntime } from '../src/strategies/smc-ml/SmcMlRuntime.js';
import type { SMCDecisionContext } from '../src/strategies/smc-ml/types.js';
import type { VetoSnapshot } from '../src/types.js';

// Wire-level tests: the real @nemesis-oss/ollama-sdk talks HTTP to a fake Ollama daemon on loopback.
// Unit tests elsewhere inject fake clients; these prove the requests the SDK actually sends.

interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

type Reply = { status: number; body: unknown } | 'hang';
type Handler = (request: RecordedRequest) => Reply;

interface FakeOllama {
  url: string;
  requests: RecordedRequest[];
  generates: () => RecordedRequest[];
  close: () => Promise<void>;
}

/** Records every request the SDK sends and answers `/api/generate` from `handler`; `/api/tags` always succeeds. */
async function startFakeOllama(host: string, handler: Handler): Promise<FakeOllama> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      const request: RecordedRequest = {
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      };
      requests.push(request);
      const reply: Reply = request.path === '/api/tags' ? { status: 200, body: { models: [{ name: config.ollama.model }] } } : handler(request);
      if (reply === 'hang') return; // never answer: the SDK timeout must abort the socket
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    requests,
    generates: () => requests.filter((request) => request.path === '/api/generate'),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/**
 * The SDK classifies only 127.0.0.1 and localhost as local, so 127.0.0.2 (loopback on Linux and CI) reaches the
 * cloud branch without a network. Returns null where that address is not bindable (e.g. macOS), so callers skip.
 */
async function startCloudLikeDaemon(handler: Handler): Promise<FakeOllama | null> {
  try {
    return await startFakeOllama('127.0.0.2', handler);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') return null;
    throw err;
  }
}

const CLOUD_SKIP = '127.0.0.2 is not bindable on this host; the cloud-branch wire test needs Linux loopback';

const ollamaReply = (response: string): Reply => ({ status: 200, body: { model: config.ollama.model, response, done: true } });

/** Points the shared config at one daemon and key pool for a single test, restoring it afterwards. */
async function withOllama(host: string, apiKeys: string[], run: () => Promise<void>): Promise<void> {
  const previous = { host: config.ollama.host, apiKeys: config.ollama.apiKeys };
  Object.assign(config.ollama, { host, apiKeys });
  try {
    await run();
  } finally {
    Object.assign(config.ollama, previous);
  }
}

async function untilOnline(advisor: OllamaAdvisor): Promise<void> {
  for (let i = 0; i < 200 && !advisor.isOnline; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(advisor.isOnline, true, 'advisor never reached the fake daemon through the SDK');
}

const snapshot: VetoSnapshot = {
  symbol: 'BTCUSDT', side: 'LONG', regime: 'HIGH', distanceFromLineAtr: 1, rsi: 55, fundingRate: 0.0001,
  entry: 100, stopLoss: 95, takeProfit: 112,
};

const smcContext = (): SMCDecisionContext => ({
  analysis: {
    symbol: 'BTCUSDT', generatedAt: 2, price: 100, timeframes: {},
    confluence: { direction: 'LONG', score: 0.8, frameScores: [], agreement: 1, reasons: ['1h: BOS bullish'], noTradeReasons: [] },
    candidates: [{
      direction: 'LONG', entrySource: 'MARKET', entryPrice: 100, protectedSwing: 98, atr14: 1, stopLoss: 97, tp1: 103, tp2: 106,
      riskPerUnit: 3, riskAtr: 3, sourceBreak: { type: 'BOS', timeframe: '1h', level: 99, time: 1, retestProbability: 0.6 },
    }],
  },
  portfolioState: 'NO_POSITION', positionQty: 0, currentMark: 100,
});

const OPEN_LONG = '{"action":"OPEN","side":"LONG","entrySource":"MARKET","reason":"aligned"}';

test('veto and ping reach a local daemon through the real SDK, with JSON mode on the wire', async () => {
  const daemon = await startFakeOllama('127.0.0.1', () => ollamaReply('{"verdict":"VETO","reason":"crowded funding"}'));
  try {
    await withOllama(daemon.url, [], async () => {
      const advisor = new OllamaAdvisor();
      await untilOnline(advisor);
      assert.deepEqual(await advisor.veto(snapshot), { verdict: 'VETO', reason: 'crowded funding' });
      assert.ok(daemon.requests.some((request) => request.path === '/api/tags'), 'ping must list models');
      const [generate] = daemon.generates();
      assert.equal(generate?.body?.model, config.ollama.model);
      assert.equal(generate?.body?.format, 'json');
      assert.equal(generate?.body?.stream, false);
    });
  } finally {
    await daemon.close();
  }
});

test('a cloud-classified host gets the Bearer key and no format field, and generateJson parses a fenced reply', async (t: TestContext) => {
  const daemon = await startCloudLikeDaemon(() => ollamaReply('```json\n{"a":1}\n```'));
  if (!daemon) return t.skip(CLOUD_SKIP);
  try {
    await withOllama(daemon.url, ['k-test'], async () => {
      const advisor = new OllamaAdvisor();
      await untilOnline(advisor);
      assert.deepEqual(await advisor.generateJson<{ a: number }>('p'), { a: 1 });
      const [generate] = daemon.generates();
      assert.equal(generate?.authorization, 'Bearer k-test');
      assert.equal(generate?.body?.format, undefined, 'no format may reach a cloud-classified host');
    });
  } finally {
    await daemon.close();
  }
});

test('the SDK refuses format on a cloud-classified host before any request, which is why jsonMode omits it', async (t: TestContext) => {
  const daemon = await startCloudLikeDaemon(() => ollamaReply('{}'));
  if (!daemon) return t.skip(CLOUD_SKIP);
  try {
    const client = new OllamaClient({ baseUrl: daemon.url, retries: 0 });
    await assert.rejects(client.generateText({ model: 'm', prompt: 'p', format: 'json' }), OllamaUnsupportedCapabilityError);
    assert.equal(daemon.generates().length, 0);
  } finally {
    await daemon.close();
  }
});

test('a 500 from the daemon is not retried by the SDK, and the veto fails open with the error', async () => {
  const daemon = await startFakeOllama('127.0.0.1', () => ({ status: 500, body: { error: 'runner crashed' } }));
  try {
    await withOllama(daemon.url, [], async () => {
      const advisor = new OllamaAdvisor();
      await untilOnline(advisor);
      const verdict = await advisor.veto(snapshot);
      assert.equal(verdict.verdict, 'PROCEED');
      assert.match(verdict.reason, /^advisor error: /);
      assert.equal(daemon.generates().length, 1, 'retries: 0 must mean exactly one attempt');
    });
  } finally {
    await daemon.close();
  }
});

test('an unreachable daemon leaves the advisor offline and the veto proceeds without waiting', async () => {
  const closed = await startFakeOllama('127.0.0.1', () => ollamaReply('{}'));
  const { url } = closed;
  await closed.close(); // the port now refuses connections
  await withOllama(url, [], async () => {
    const started = Date.now();
    const advisor = new OllamaAdvisor();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(advisor.isOnline, false);
    assert.deepEqual(await advisor.veto(snapshot), { verdict: 'PROCEED', reason: 'advisor offline' });
    const decision = await new SmcExecutionAdvisor({ host: url, model: 'm' }).decide(smcContext());
    assert.equal(decision.action, 'HOLD');
    assert.ok(Date.now() - started < 3000, 'a refused connection must fail fast, not wait out the timeout');
  });
});

test('a rate-limited key fails over to the next key, each request carrying its own Bearer token', async (t: TestContext) => {
  const daemon = await startCloudLikeDaemon((request) =>
    request.authorization === 'Bearer k-1' ? { status: 429, body: { error: 'rate limit' } } : ollamaReply('{"verdict":"VETO","reason":"second key"}'));
  if (!daemon) return t.skip(CLOUD_SKIP);
  try {
    await withOllama(daemon.url, ['k-1', 'k-2'], async () => {
      const advisor = new OllamaAdvisor();
      await untilOnline(advisor);
      assert.deepEqual(await advisor.veto(snapshot), { verdict: 'VETO', reason: 'second key' });
      assert.deepEqual(daemon.generates().map((request) => request.authorization), ['Bearer k-1', 'Bearer k-2']);
    });
  } finally {
    await daemon.close();
  }
});

test('SMC advisor decides through the real SDK on a local daemon, with JSON mode on the wire', async () => {
  const daemon = await startFakeOllama('127.0.0.1', () => ollamaReply(OPEN_LONG));
  try {
    const decision = await new SmcExecutionAdvisor({ host: daemon.url, model: 'm' }).decide(smcContext());
    assert.equal(decision.action, 'OPEN');
    const [generate] = daemon.generates();
    assert.deepEqual([generate?.body?.model, generate?.body?.format, generate?.body?.stream], ['m', 'json', false]);
  } finally {
    await daemon.close();
  }
});

test('SMC advisor fails closed near its timeout when the daemon never answers', async () => {
  const daemon = await startFakeOllama('127.0.0.1', () => 'hang');
  try {
    const started = Date.now();
    const decision = await new SmcExecutionAdvisor({ host: daemon.url, model: 'm', timeoutMs: 150 }).decide(smcContext());
    assert.equal(decision.action, 'HOLD');
    assert.ok(Date.now() - started < 2000, 'must give up near the configured timeout');
  } finally {
    await daemon.close();
  }
});

/** Cloud-like daemon that refuses any generate without the expected Bearer token, as ollama.com does. */
const requireBearer = (token: string): Handler => (request) =>
  request.authorization === `Bearer ${token}` ? ollamaReply(OPEN_LONG) : { status: 401, body: { error: 'unauthorized' } };

test('SMC advisor authenticates against a cloud-classified host with the configured key', async (t: TestContext) => {
  const daemon = await startCloudLikeDaemon(requireBearer('k-smc'));
  if (!daemon) return t.skip(CLOUD_SKIP);
  try {
    const decision = await new SmcExecutionAdvisor({ host: daemon.url, model: 'm', apiKey: 'k-smc' }).decide(smcContext());
    assert.equal(decision.action, 'OPEN', 'an unauthenticated cloud call is refused (401) and fails closed to HOLD');
    const [generate] = daemon.generates();
    assert.equal(generate?.authorization, 'Bearer k-smc');
    assert.equal(generate?.body?.format, undefined);
  } finally {
    await daemon.close();
  }
});

test('SmcMlRuntime.fromConfig hands the configured Ollama key to the SMC advisor', async (t: TestContext) => {
  const daemon = await startCloudLikeDaemon(requireBearer('k-runtime'));
  if (!daemon) return t.skip(CLOUD_SKIP);
  try {
    await withOllama(daemon.url, ['k-runtime'], async () => {
      const runtime = SmcMlRuntime.fromConfig();
      const advisor = (runtime as unknown as { advisor: SmcExecutionAdvisor }).advisor;
      assert.equal((await advisor.decide(smcContext())).action, 'OPEN');
      assert.equal(daemon.generates()[0]?.authorization, 'Bearer k-runtime');
    });
  } finally {
    await daemon.close();
  }
});
