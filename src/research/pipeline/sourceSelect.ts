/**
 * Picks the kline source for the host the pipeline runs on, so one command works on GitHub Actions, a local machine or a
 * cloud host. `auto` pings fapi.binance.com: reachable -> api; HTTP 451 (region-blocked, e.g. US-hosted runners) or any
 * failure -> archive. The choice and its reason are recorded in the run output.
 */
import type { KlineSource } from '../../backtesting/klineLoader.js';

export type SourcePreference = 'auto' | KlineSource;

export interface SourceChoice {
  source: KlineSource;
  reason: string;
}

export type PingLike = (url: string) => Promise<{ ok: boolean; status: number }>;

const PING_URL = 'https://fapi.binance.com/fapi/v1/ping';

export async function selectSource(preference: SourcePreference, ping: PingLike = defaultPing): Promise<SourceChoice> {
  if (preference === 'api' || preference === 'archive') return { source: preference, reason: `forced by --source ${preference}` };
  try {
    const response = await ping(PING_URL);
    if (response.ok) return { source: 'api', reason: 'fapi.binance.com reachable' };
    return { source: 'archive', reason: `fapi.binance.com answered HTTP ${response.status}` };
  } catch (error) {
    return { source: 'archive', reason: `fapi.binance.com unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function defaultPing(url: string): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { ok: response.ok, status: response.status };
}
