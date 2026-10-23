export const DEFAULT_PAPER_EXCHANGE_URL = 'http://127.0.0.1:3100';

export interface FleetPaperExchange {
  url: string;
  apiKey: string;
}

/**
 * Resolves the paper_exchange endpoint and operator token for the MiniCPM fleet. The token has no default: a missing or
 * blank PAPER_EXCHANGE_API_KEY throws before the fleet touches the broker or any market feed.
 */
export function resolveFleetPaperExchange(env: NodeJS.ProcessEnv): FleetPaperExchange {
  const apiKey = env.PAPER_EXCHANGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('PAPER_EXCHANGE_API_KEY is not set. The MiniCPM fleet needs the paper_exchange operator token and has no built-in default.');
  }
  const url = (env.PAPER_EXCHANGE_URL?.trim() || DEFAULT_PAPER_EXCHANGE_URL).replace(/\/+$/, '');
  return { url, apiKey };
}
