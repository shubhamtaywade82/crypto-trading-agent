export interface PaperExchangeOnlySettings {
  mode: string;
  binanceTestnet: boolean;
  paperExchange: {
    url: string;
    accountId: string;
    apiKey?: string;
  } | null;
}

/**
 * Fail-closed startup guard for the dedicated PaperExchange runner.
 *
 * This is intentionally separate from the application's general MODE=paper
 * behavior, which still supports the local in-memory simulator for research.
 */
export function assertPaperExchangeOnly(settings: PaperExchangeOnlySettings): void {
  if (settings.mode !== 'paper') {
    throw new Error('PaperExchange-only runner requires MODE=paper; live execution is disabled.');
  }

  if (settings.binanceTestnet) {
    throw new Error('PaperExchange-only runner requires BINANCE_TESTNET=off; Binance is market-data-only.');
  }

  const exchange = settings.paperExchange;
  if (!exchange) {
    throw new Error(
      'PaperExchange-only runner requires PAPER_EXCHANGE_URL and PAPER_EXCHANGE_ACCOUNT_ID; local paper fallback is disabled.',
    );
  }

  if (!exchange.url.trim()) {
    throw new Error('PAPER_EXCHANGE_URL must be a non-empty HTTP(S) URL.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(exchange.url);
  } catch {
    throw new Error('PAPER_EXCHANGE_URL must be a valid HTTP(S) URL.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('PAPER_EXCHANGE_URL must use HTTP or HTTPS.');
  }

  if (!exchange.accountId.trim()) {
    throw new Error('PAPER_EXCHANGE_ACCOUNT_ID must be a non-empty account identifier.');
  }

  if (!exchange.apiKey?.trim()) {
    throw new Error('PAPER_EXCHANGE_API_KEY is required by the PaperExchange-only runner.');
  }
}
