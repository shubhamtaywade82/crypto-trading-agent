import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UserDataStream, type ListenKeyPort, type SocketFactory, type StreamSocket } from '../src/binance/userDataStream.js';

/**
 * The private user-data stream lifecycle against a scripted fake socket and fake listen-key REST
 * port: connection URL, event delivery, keepalive, key expiry, reconnection, duplicate-loop
 * protection, shutdown hygiene, and that no log line ever carries the raw listen key.
 *
 * Every test owns its stream inside try/finally, so a failed assertion can never leave the
 * keepalive/reconnect timers running (they would keep the test process alive).
 */

type Handler = { open?: () => void; message?: (data: unknown) => void; close?: (code: number | null, reason: string) => void; error?: (err: unknown) => void };

/** A scriptable socket: tests fire open/message/error by hand; close() behaves like a real socket
 * and delivers the close event on a microtask, so shutdown and expiry paths run as they would live. */
class FakeSocket implements StreamSocket {
  public closed = false;
  public closeCode?: number;
  private readonly handlers: Handler = {};

  constructor(public readonly url: string) {}

  onOpen(handler: () => void): void { this.handlers.open = handler; }
  onMessage(handler: (data: unknown) => void): void { this.handlers.message = handler; }
  onClose(handler: (code: number | null, reason: string) => void): void { this.handlers.close = handler; }
  onError(handler: (err: unknown) => void): void { this.handlers.error = handler; }

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    queueMicrotask(() => this.handlers.close?.(code ?? null, code === 4000 ? 'key expired' : 'closing'));
  }

  // test drivers
  fireOpen(): void { this.handlers.open?.(); }
  fireMessage(data: unknown): void { this.handlers.message?.(data); }
  fireClose(code: number | null = 1006, reason = ''): void {
    this.closed = true;
    this.handlers.close?.(code, reason);
  }
  fireError(err: unknown): void { this.handlers.error?.(err); }
}

interface Harness {
  sockets: FakeSocket[];
  createdKeys: () => number;
  keptAlive: () => number;
  closedKeys: () => number;
  events: { type: string; payload: unknown }[];
  logs: { message: string; level: string }[];
  make(overrides?: { keys?: ListenKeyPort; onEvent?: (event: { type: string; payload: unknown }) => void }): UserDataStream;
}

const harness = (): Harness => {
  const sockets: FakeSocket[] = [];
  const events: { type: string; payload: unknown }[] = [];
  const logs: { message: string; level: string }[] = [];
  const counts = { created: 0, keptAlive: 0, closed: 0, current: 0 };
  const defaultKeys: ListenKeyPort = {
    create: async () => { counts.created++; counts.current++; return `listen-key-${counts.current}`; },
    keepAlive: async () => { counts.keptAlive++; },
    close: async () => { counts.closed++; },
  };
  const factory: SocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  const make: Harness['make'] = (overrides) => new UserDataStream({
    environment: 'live',
    keys: overrides?.keys ?? defaultKeys,
    onEvent: overrides?.onEvent ?? ((event) => events.push(event)),
    log: (message, level) => logs.push({ message, level }),
    keepAliveIntervalMs: 10,
    reconnectBaseMs: 1,
    reconnectMaxMs: 5,
    socketFactory: factory,
  });
  return {
    sockets,
    createdKeys: () => counts.created,
    keptAlive: () => counts.keptAlive,
    closedKeys: () => counts.closed,
    events, logs, make,
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects the stream and resolves on the first open socket. */
const connectOnce = async (h: Harness, stream: UserDataStream): Promise<void> => {
  const started = stream.start();
  await sleep(5);
  h.sockets[0]!.fireOpen();
  await started;
};

test('connects on the documented private route with the key and events as query parameters', async () => {
  const h = harness();
  const stream = h.make();
  try {
    await connectOnce(h, stream);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0]!.url, 'wss://fstream.binance.com/private/ws?listenKey=listen-key-1&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/MARGIN_CALL');
    assert.equal(stream.status.state, 'CONNECTED');
  } finally {
    await stream.stop();
  }
});

test('a listen key is created once and reused across reconnects until it expires', async () => {
  const h = harness();
  const stream = h.make();
  try {
    await connectOnce(h, stream);
    // the venue drops the connection (the documented 24-hour rotation ends the same way)
    h.sockets[0]!.fireClose(1000, 'rotation');
    await sleep(30);
    h.sockets[1]!.fireOpen();
    assert.equal(h.sockets.length, 2);
    assert.equal(h.createdKeys(), 1, 'a healthy key is kept across reconnects');
    assert.equal(h.sockets[1]!.url, h.sockets[0]!.url);
    assert.equal(stream.status.state, 'CONNECTED');
  } finally {
    await stream.stop();
  }
});

test('user events reach the application; an unknown event type is reported, never fatal', async () => {
  const h = harness();
  const stream = h.make();
  try {
    await connectOnce(h, stream);
    const socket = h.sockets[0]!;
    socket.fireMessage(JSON.stringify({ e: 'ORDER_TRADE_UPDATE', o: { s: 'BTCUSDT', c: 'e123', X: 'FILLED', z: '2', l: '2', ap: '100', rp: '5' } }));
    socket.fireMessage(JSON.stringify({ e: 'ACCOUNT_UPDATE', a: { m: 'ACCOUNT', B: [] } }));
    socket.fireMessage('not json at all');
    socket.fireMessage(JSON.stringify({ e: 'SOME_FUTURE_EVENT', x: 1 }));
    socket.fireMessage(JSON.stringify({ noType: true }));
    assert.deepEqual(h.events.map((e) => e.type), ['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE']);
    assert.ok(h.logs.some((l) => l.message.includes('not JSON')));
    assert.ok(h.logs.some((l) => l.message.includes('SOME_FUTURE_EVENT')), 'unknown events are reported');
    assert.equal(stream.status.state, 'CONNECTED', 'unknown events do not take the stream down');
  } finally {
    await stream.stop();
  }
});

test('a throwing application handler is contained: the stream stays up for the next event', async () => {
  const h = harness();
  const stream = h.make({ onEvent: () => { throw new Error('handler bug'); } });
  try {
    await connectOnce(h, stream);
    const socket = h.sockets[0]!;
    socket.fireMessage(JSON.stringify({ e: 'ORDER_TRADE_UPDATE' }));
    socket.fireMessage(JSON.stringify({ e: 'ACCOUNT_UPDATE' }));
    assert.equal(h.logs.filter((l) => l.level === 'error' && l.message.includes('handler')).length, 2);
    assert.equal(stream.status.state, 'CONNECTED');
  } finally {
    await stream.stop();
  }
});

test('listenKeyExpired closes the connection and reconnects with a fresh key', async () => {
  const h = harness();
  const stream = h.make();
  try {
    await connectOnce(h, stream);
    h.sockets[0]!.fireMessage(JSON.stringify({ e: 'listenKeyExpired' }));
    await sleep(30);
    const second = h.sockets[1]!;
    second.fireOpen();
    assert.equal(h.createdKeys(), 2, 'the expired key is replaced');
    assert.ok(second.url.includes('listenKey=listen-key-2'));
    assert.ok(h.sockets[0]!.closed, 'the old socket is closed');
    assert.equal(stream.status.state, 'CONNECTED');
  } finally {
    await stream.stop();
  }
});

test('repeated keepalive failures recycle the key; a successful keepalive resets the failure count', async () => {
  const h = harness();
  let failuresRemaining = 0;
  let created = 0;
  const keys: ListenKeyPort = {
    create: async () => { created++; return `listen-key-${created}`; },
    keepAlive: async () => { if (failuresRemaining > 0) { failuresRemaining--; throw new Error('keepalive refused'); } },
    close: async () => {},
  };
  const stream = h.make({ keys });
  try {
    await connectOnce(h, stream);
    // two failures then a success: below the limit, the key survives
    failuresRemaining = 2;
    await sleep(40);
    assert.equal(created, 1, 'failures below the limit keep the key');
    assert.ok(h.logs.some((l) => l.message.includes('keepalive 1/3')), 'the first failure is surfaced');
    assert.ok(h.logs.some((l) => l.message.includes('keepalive 2/3')), 'the second failure is surfaced');
    // three failures in a row: the key is assumed expired and replaced
    failuresRemaining = 3;
    await sleep(80);
    assert.ok(created >= 2, 'the burnt key is replaced');
    const latest = h.sockets.at(-1)!;
    latest.fireOpen();
    assert.ok(latest.url.includes(`listenKey=listen-key-${created}`));
    assert.equal(stream.status.state, 'CONNECTED');
  } finally {
    await stream.stop();
  }
});

test('a failed first connection keeps retrying in the background until the venue answers', async () => {
  const h = harness();
  let createShouldFail = true;
  const keys: ListenKeyPort = {
    create: async () => { if (createShouldFail) throw new Error('venue unreachable'); return 'key-1'; },
    keepAlive: async () => {},
    close: async () => {},
  };
  const stream = h.make({ keys });
  try {
    await stream.start(); // resolves without throwing even though nothing connected
    assert.notEqual(stream.status.state, 'CONNECTED');
    createShouldFail = false;
    await sleep(30);
    h.sockets[0]!.fireOpen();
    assert.equal(stream.status.state, 'CONNECTED', 'recovery needs no external retry call');
  } finally {
    await stream.stop();
  }
});

test('a close before open retries without stacking a second reconnect loop', async () => {
  const h = harness();
  const stream = h.make();
  try {
    const started = stream.start();
    await sleep(5);
    h.sockets[0]!.fireClose(1006, 'refused'); // never opened
    await started;
    await sleep(40);
    assert.ok(h.sockets.length >= 2, 'the attempt is retried');
    h.sockets.at(-1)!.fireOpen();
    assert.equal(stream.status.state, 'CONNECTED');
  } finally {
    await stream.stop();
    assert.ok(h.sockets.every((s) => s.closed), 'stop() closes every socket it ever created');
  }
});

test('stop() releases the listen key, cancels timers and ignores late socket callbacks', async () => {
  const h = harness();
  const stream = h.make();
  try {
    await connectOnce(h, stream);
    await stream.stop();
    assert.equal(h.closedKeys(), 1, 'the REST close ran');
    assert.equal(stream.status.state, 'STOPPED');
    // a straggler event from the retired socket must not resurrect state or crash
    h.sockets[0]!.fireMessage(JSON.stringify({ e: 'ORDER_TRADE_UPDATE' }));
    h.sockets[0]!.fireClose(1006, 'late');
    assert.deepEqual(h.events, []);
    assert.equal(stream.status.state, 'STOPPED');
  } finally {
    await stream.stop();
  }
});

test('no log line ever contains a raw listen key', async () => {
  const h = harness();
  const stream = h.make();
  try {
    await connectOnce(h, stream);
    h.sockets[0]!.fireClose(1000, 'x');
    await sleep(30);
    h.sockets.at(-1)!.fireOpen();
  } finally {
    await stream.stop();
  }
  for (const line of h.logs) {
    assert.ok(!line.message.includes('listen-key-1'), `raw key leaked: ${line.message}`);
    assert.ok(!line.message.includes('listen-key-2'), `raw key leaked: ${line.message}`);
  }
  assert.ok(h.logs.some((l) => l.message.includes('listen')), 'the masked key is still visible for operators');
});
