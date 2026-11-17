/**
 * Which USD-M route carries which stream, measured from this machine. Read-only: public market data, no keys, no orders.
 *
 *   npx tsx scripts/probe-usdm-routes.ts [SYMBOL] [SECONDS]
 *
 * Run it where Binance is reachable. A silent control means the probe is blocked, not the routes, and no verdict is printed.
 * Move a feed to a new route only on evidence from this probe.
 */
import { eventTypeOf, probeRoutes, verdicts, type ProbeResult, type ProbeRoute } from '../src/fleet/routeProbe.js';

interface ProbeSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

type SocketConstructor = new (url: string) => ProbeSocket;

function probe(route: ProbeRoute, seconds: number): Promise<ProbeResult> {
  const result: ProbeResult = { name: route.name, url: route.url, connected: false, messages: 0, eventTypes: [] };
  const Socket = (globalThis as unknown as { WebSocket?: SocketConstructor }).WebSocket;
  return new Promise((resolve) => {
    if (!Socket) {
      resolve({ ...result, error: 'no global WebSocket in this Node (needs Node 22+)' });
      return;
    }
    let ws: ProbeSocket;
    try {
      ws = new Socket(route.url);
    } catch (err) {
      resolve({ ...result, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => ws.close(), seconds * 1000);
    ws.onopen = () => {
      result.connected = true;
    };
    ws.onmessage = (event) => {
      result.messages += 1;
      const type = eventTypeOf(String(event.data));
      if (type && !result.eventTypes.includes(type)) result.eventTypes.push(type);
    };
    ws.onerror = () => {
      result.error = 'socket error';
    };
    ws.onclose = () => {
      clearTimeout(timer);
      resolve(result);
    };
  });
}

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? 'ETHUSDT').toUpperCase();
  const seconds = Number(process.argv[3] ?? 20);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('SECONDS must be a positive number');

  console.log(`probing ${symbol} for ${seconds}s per route (public market data, no keys)`);
  const results = await Promise.all(probeRoutes(symbol).map((route) => probe(route, seconds)));
  for (const r of results) {
    const state = r.connected ? 'connected' : 'NOT connected';
    const types = r.eventTypes.length > 0 ? ` events=${r.eventTypes.join(',')}` : '';
    const err = r.error ? ` [${r.error}]` : '';
    console.log(`${String(r.messages).padStart(6)} msgs  ${state.padEnd(13)}  ${r.name}${types}${err}`);
  }
  console.log('');
  for (const line of verdicts(results)) console.log(line);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
