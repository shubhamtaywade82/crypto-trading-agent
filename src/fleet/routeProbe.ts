/**
 * Pure helpers for scripts/probe-usdm-routes.ts. They decide nothing on their own: the probe reports which USD-M route carries
 * which stream, and a person decides whether a feed moves.
 */

export interface ProbeRoute {
  name: string;
  url: string;
}

export interface ProbeResult {
  name: string;
  url: string;
  connected: boolean;
  messages: number;
  eventTypes: string[];
  error?: string;
}

const ROOT = 'wss://fstream.binance.com';

/** The routes compared for one symbol. The first is the control: the legacy @trade feed that the live tick path is known to stream. */
export function probeRoutes(symbol: string): ProbeRoute[] {
  const s = symbol.toLowerCase();
  return [
    { name: 'legacy @trade (control)', url: `${ROOT}/ws/${s}@trade` },
    { name: 'legacy @aggTrade', url: `${ROOT}/ws/${s}@aggTrade` },
    { name: '/market/stream @aggTrade', url: `${ROOT}/market/stream?streams=${s}@aggTrade` },
    { name: '/market/ws @aggTrade', url: `${ROOT}/market/ws/${s}@aggTrade` },
    { name: '/market/stream @markPrice@1s', url: `${ROOT}/market/stream?streams=${s}@markPrice@1s` },
  ];
}

/** The event type of one frame, from raw or combined-stream form. Null for anything that is not a market event. */
export function eventTypeOf(frame: string): string | null {
  try {
    const parsed = JSON.parse(frame) as { e?: unknown; data?: { e?: unknown } };
    if (typeof parsed.e === 'string') return parsed.e;
    if (typeof parsed.data?.e === 'string') return parsed.data.e;
    return null;
  } catch {
    return null;
  }
}

/** One line per route. A silent control means the probe, not the routes, is at fault, so no route verdict is given. */
export function verdicts(results: ProbeResult[]): string[] {
  const control = results[0];
  if (!control || control.messages === 0) {
    return ['control route (legacy @trade) is silent: the network or the symbol is at fault, so no route verdict is valid'];
  }
  return results.slice(1).map((r) => {
    if (r.messages > 0) return `${r.name}: streams (${r.messages} msgs)`;
    return `${r.name}: silent (${r.error ?? (r.connected ? 'connected' : 'not connected')})`;
  });
}
