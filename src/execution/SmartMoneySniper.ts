import Decimal from 'decimal.js';

export interface SmartMoneySignal {
  readonly signalId: number;
  readonly ticker: string;
  readonly chainId: string;
  readonly contractAddress: string;
  readonly launchPlatform?: string | null;
  readonly smartSignalType: string;
  readonly smartMoneyCount: number;
  readonly direction: string;
  readonly alertPrice: string;
  readonly currentPrice: string;
  readonly exitRate: number;
  readonly status: string;
  readonly signalTriggerTime: number;
  readonly tokenTag?: Readonly<Record<string, ReadonlyArray<{ readonly tagName: string }>>>;
}

export interface SniperConfig {
  readonly takeProfitPct: number;
  readonly stopLossPct: number;
  readonly timeStopMs: number;
  readonly maxExitRate: number;
  readonly minSmartMoneyCount: number;
  readonly positionSizeUsd: number;
}

export interface SniperPosition {
  readonly signalId: number;
  readonly ticker: string;
  readonly chainId: string;
  readonly contractAddress: string;
  readonly entryPrice: number;
  readonly targetPrice: number;
  readonly stopPrice: number;
  readonly entryTimeMs: number;
  readonly expiryTimeMs: number;
  readonly positionSizeUsd: number;
  readonly status: 'OPEN' | 'TP_HIT' | 'SL_HIT' | 'EXPIRED';
  readonly exitPrice?: number;
  readonly realizedPnlUsd?: number;
}

export const DEFAULT_SNIPER_CONFIG: SniperConfig = {
  takeProfitPct: 0.20,
  stopLossPct: 0.10,
  timeStopMs: 15 * 60 * 1000,
  maxExitRate: 30,
  minSmartMoneyCount: 3,
  positionSizeUsd: 200,
};

const BINANCE_WEB3_SIGNAL_URL =
  'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/web/signal/smart-money/ai';

// Checks if any tag category matches the specified tag name
function hasTag(signal: SmartMoneySignal, tagName: string): boolean {
  if (!signal.tokenTag) return false;
  return Object.values(signal.tokenTag).some((tags) =>
    tags.some((t) => t.tagName === tagName)
  );
}

// Empirical backtest proved non-Pumpfun and unverified tokens have poor risk/reward
function hasRequiredPlatformOrTag(signal: SmartMoneySignal): boolean {
  const isPumpfun = signal.launchPlatform === 'Pumpfun';
  const isDexPaid = hasTag(signal, 'DEX Paid');
  return isPumpfun || isDexPaid;
}

// Disqualifies exhausted signals, high-tax traps, and non-buy events
export function isSniperEligible(
  signal: SmartMoneySignal,
  config: SniperConfig = DEFAULT_SNIPER_CONFIG
): boolean {
  if (signal.direction !== 'buy') return false;
  if (!['valid', 'active'].includes(signal.status)) return false;
  if (signal.exitRate > config.maxExitRate) return false;
  if (signal.smartMoneyCount < config.minSmartMoneyCount) return false;
  if (hasTag(signal, 'High Tax Token')) return false;

  return hasRequiredPlatformOrTag(signal);
}

// Derives take-profit, stop-loss, and time-stop limits using Decimal to prevent precision drift
export function createSniperPosition(
  signal: SmartMoneySignal,
  config: SniperConfig = DEFAULT_SNIPER_CONFIG,
  entryTimeMs: number = Date.now()
): SniperPosition {
  const entry = new Decimal(signal.alertPrice);
  const target = entry.times(new Decimal(1).plus(config.takeProfitPct));
  const stop = entry.times(new Decimal(1).minus(config.stopLossPct));

  return {
    signalId: signal.signalId,
    ticker: signal.ticker,
    chainId: signal.chainId,
    contractAddress: signal.contractAddress,
    entryPrice: entry.toNumber(),
    targetPrice: target.toNumber(),
    stopPrice: stop.toNumber(),
    entryTimeMs,
    expiryTimeMs: entryTimeMs + config.timeStopMs,
    positionSizeUsd: config.positionSizeUsd,
    status: 'OPEN',
  };
}

// Resolves execution outcome against predetermined profit, stop, or timeout limits
export function evaluatePositionTick(
  pos: SniperPosition,
  currentPrice: number,
  nowMs: number = Date.now()
): SniperPosition {
  if (pos.status !== 'OPEN') return pos;

  const entry = new Decimal(pos.entryPrice);
  const target = new Decimal(pos.targetPrice);
  const stop = new Decimal(pos.stopPrice);
  const current = new Decimal(currentPrice);
  const size = new Decimal(pos.positionSizeUsd);

  if (current.gte(target)) {
    const returnPct = target.minus(entry).div(entry);
    return {
      ...pos,
      status: 'TP_HIT',
      exitPrice: target.toNumber(),
      realizedPnlUsd: size.times(returnPct).toNumber(),
    };
  }

  if (current.lte(stop)) {
    const returnPct = stop.minus(entry).div(entry);
    return {
      ...pos,
      status: 'SL_HIT',
      exitPrice: stop.toNumber(),
      realizedPnlUsd: size.times(returnPct).toNumber(),
    };
  }

  if (nowMs >= pos.expiryTimeMs) {
    const returnPct = current.minus(entry).div(entry);
    return {
      ...pos,
      status: 'EXPIRED',
      exitPrice: current.toNumber(),
      realizedPnlUsd: size.times(returnPct).toNumber(),
    };
  }

  return pos;
}

// Generates an operator-friendly HTML card for Telegram broadcast
export function formatSniperCard(
  signal: SmartMoneySignal,
  pos: SniperPosition
): string {
  const chainName = signal.chainId === 'CT_501' ? 'Solana' : 'BSC';
  const dexUrl = signal.chainId === 'CT_501'
    ? `https://dexscreener.com/solana/${signal.contractAddress}`
    : `https://dexscreener.com/bsc/${signal.contractAddress}`;

  return [
    `🎯 <b>SMART MONEY SNIPER ALERT</b>`,
    ``,
    `🪙 <b>Token:</b> ${signal.ticker} (${chainName})`,
    `⚡ <b>Type:</b> ${signal.smartSignalType} · ${signal.smartMoneyCount} Wallets`,
    `🚪 <b>Exit Rate:</b> ${signal.exitRate}%`,
    ``,
    `📥 <b>Entry:</b> $${pos.entryPrice.toFixed(8)}`,
    `🎯 <b>Target (+20%):</b> $${pos.targetPrice.toFixed(8)}`,
    `🛑 <b>Stop (-10%):</b> $${pos.stopPrice.toFixed(8)}`,
    `⏱️ <b>Time Horizon:</b> 15 min max`,
    `💵 <b>Size:</b> $${pos.positionSizeUsd.toFixed(0)} USD`,
    ``,
    `🔗 <a href="${dexUrl}">View on DexScreener</a>`,
  ].join('\n');
}

// Queries Binance Web3 BAPI with strict timeout to avoid blocking execution loops
export async function fetchSmartMoneySignals(
  chainId: string = 'CT_501',
  pageSize: number = 50,
  fetchImpl: typeof fetch = fetch
): Promise<SmartMoneySignal[]> {
  const response = await fetchImpl(BINANCE_WEB3_SIGNAL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'User-Agent': 'binance-web3/2.0 (Skill)',
    },
    body: JSON.stringify({ chainId, page: 1, pageSize }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch smart-money signals: HTTP ${response.status}`);
  }

  const json = (await response.json()) as { data?: SmartMoneySignal[] };
  return json.data ?? [];
}
