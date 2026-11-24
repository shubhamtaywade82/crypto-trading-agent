import type { MarketState } from '../market/types.js';

/** The model picks direction only: stop and target come from deterministic ATR code (fleetLevels), never from the model. */
export interface LlmTradeRecommendation {
  action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD';
  confidence: number;
  reason: string;
}

export interface PromptInput {
  symbol: string;
  currentPrice: number;
  btcContext: {
    price: number;
    trend1h: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    trend15m: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    change24hPct: number;
  };
  symbolContext: {
    price: number;
    trend1h: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    trend15m: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    change24hPct: number;
    atr14: number;
    support: number;
    resistance: number;
    recentHigh: number;
    recentLow: number;
  };
  /** Rich market intelligence from the deterministic engine. */
  marketState?: MarketState;
  /** Context-only alts (not traded): breadth around the traded symbol. */
  peers?: PeerContext[];
}

export interface PeerContext {
  symbol: string;
  trend1h: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
  change24hPct: number;
}

const TRADE_CONSTRAINTS = `### YOUR DECISION:
Choose direction only. The system sets the stop at 1.5x ATR(14) and the target at 2R (at least 0.5% away) from the current price.
Output "ENTER_LONG", "ENTER_SHORT", or "HOLD" if the setup is unclear or a 1.5x ATR stop would sit inside obvious noise.`;

function fmtNum(n: number | null | undefined, digits = 4): string {
  return n != null && Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function buildMarketIntelSection(state: MarketState): string {
  const { regime, htfStructure, ltfStructure, liquidity, meanReversion, crowding, pricing } = state;
  const tf15 = state.timeframes['15m'];
  const tf1h = state.timeframes['1h'];

  const sweeps = liquidity.ltf.latestSweeps.length > 0
    ? liquidity.ltf.latestSweeps.map((s) => `${s.direction}@${s.level.toFixed(2)}`).join(', ')
    : 'none';
  const pools = liquidity.htf.pools.slice(0, 3).map((p) => `${p.type}@${p.price.toFixed(2)}`).join(', ') || 'none';
  const crowd = crowding
    ? `${crowding.positioningExtreme} | funding-pct ${fmtNum(crowding.fundingPercentile, 0)} | OI-exp ${crowding.openInterestExpansion}`
    : 'n/a';

  return `### MARKET INTELLIGENCE (deterministic engine):
Regime : ${regime.regime} (${regime.trendDirection}, ADX ${fmtNum(regime.adx14, 1)}, vol-pct ${fmtNum(regime.volatilityPercentile, 0)})
HTF structure : ${htfStructure.trend} | last-break ${htfStructure.lastBreak ? `${htfStructure.lastBreak.type}-${htfStructure.lastBreak.direction}` : 'none'}
LTF structure : ${ltfStructure.trend} | last-break ${ltfStructure.lastBreak ? `${ltfStructure.lastBreak.type}-${ltfStructure.lastBreak.direction}` : 'none'}
LTF sweeps    : ${sweeps}
HTF liq pools : ${pools}
Premium/disc  : pos ${fmtNum(pricing.positionPct, 0)}% — ${pricing.premium ? 'PREMIUM' : pricing.discount ? 'DISCOUNT' : 'EQUILIBRIUM'}
MR z-score    : ${fmtNum(meanReversion.zscore, 2)} | RSI14 ${fmtNum(meanReversion.rsi14, 1)} | dev ${fmtNum(meanReversion.deviationPct, 2)}%
ATR14 (15m)   : ${fmtNum(tf15.atr14)} | ATR14 (1h) ${fmtNum(tf1h.atr14)}
Funding       : ${(state.fundingRate * 100).toFixed(4)}%
Crowding      : ${crowd}`;
}

// Everything constant comes first: an identical prompt prefix is billed at the provider's cached-input rate.
const STATIC_PREFIX = `You are an elite quantitative crypto trader operating with 10x leverage on Binance USDT-Margined Futures.
Decide on the traded asset below, using BTCUSDT and the other alts as market context.

${TRADE_CONSTRAINTS}

Return ONLY a valid JSON object with EXACTLY this structure (no markdown fences, no explanatory text):
{
  "action": "ENTER_LONG" | "ENTER_SHORT" | "HOLD",
  "confidence": 0.85,
  "reason": "Brief technical rationale"
}`;

function buildPeersSection(peers: PeerContext[]): string {
  const lines = peers.map((p) => `- ${p.symbol}: 1h ${p.trend1h} | 24h ${p.change24hPct.toFixed(2)}%`);
  return `\n### ALT BREADTH (context only, not traded):\n${lines.join('\n')}\n`;
}

export function buildTradingPrompt(input: PromptInput): string {
  const intel = input.marketState ? `\n${buildMarketIntelSection(input.marketState)}\n` : '';
  const peers = input.peers?.length ? buildPeersSection(input.peers) : '';
  const { symbol, symbolContext: s, btcContext: b } = input;

  return `${STATIC_PREFIX}

### MACRO CONTEXT (BTCUSDT Anchor):
- BTC Price: $${b.price.toFixed(2)} | 1h: ${b.trend1h} | 15m: ${b.trend15m} | 24h: ${b.change24hPct.toFixed(2)}%

### ASSET DATA (${symbol}):
- Current Price: $${s.price} | 1h: ${s.trend1h} | 15m: ${s.trend15m} | 24h: ${s.change24hPct.toFixed(2)}%
- ATR(14): ${s.atr14.toFixed(4)} | Support: ${s.support} | Resistance: ${s.resistance}
- Swing High: ${s.recentHigh} | Swing Low: ${s.recentLow}
${peers}${intel}`;
}
