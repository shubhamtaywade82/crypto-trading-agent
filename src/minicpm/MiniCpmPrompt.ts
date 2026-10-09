export interface LlmTradeRecommendation {
  action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD';
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
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
}

export function buildTradingPrompt(input: PromptInput): string {
  const minProfitMovePct = 0.5; // At 10x leverage, 0.5% price move = 5% return on $1,000 margin ($50)
  return `You are an elite quantitative crypto trader operating with 10x leverage on Binance USDT-Margined Futures.
Analyze market data for ${input.symbol} using BTCUSDT as macro context anchor.

### MACRO CONTEXT (BTCUSDT Anchor):
- BTC Price: $${input.btcContext.price.toFixed(2)}
- BTC 1h Trend: ${input.btcContext.trend1h}
- BTC 15m Trend: ${input.btcContext.trend15m}
- BTC 24h Change: ${input.btcContext.change24hPct.toFixed(2)}%

### ASSET DATA (${input.symbol}):
- Current Price: $${input.symbolContext.price}
- 1h Trend: ${input.symbolContext.trend1h}
- 15m Trend: ${input.symbolContext.trend15m}
- 24h Change: ${input.symbolContext.change24hPct.toFixed(2)}%
- ATR(14): ${input.symbolContext.atr14.toFixed(4)}
- Support Level: ${input.symbolContext.support}
- Resistance Level: ${input.symbolContext.resistance}
- Recent Swing High: ${input.symbolContext.recentHigh}
- Recent Swing Low: ${input.symbolContext.recentLow}

### TRADE OBJECTIVES & MANDATORY CONSTRAINTS:
1. Minimum Profit Target: At 10x leverage, the Take Profit (TP) MUST deliver at least 5% gain on margin, which requires at least ${minProfitMovePct}% price distance from entry.
   - For LONG: takeProfit >= currentPrice * 1.005
   - For SHORT: takeProfit <= currentPrice * 0.995
2. Stop Loss (SL):
   - For LONG: stopLoss must be placed below local support/swing low (currentPrice > stopLoss).
   - For SHORT: stopLoss must be placed above local resistance/swing high (currentPrice < stopLoss).
   - Minimum Risk/Reward Ratio: (Reward / Risk) must be >= 1.5.
3. Decision: Output "ENTER_LONG", "ENTER_SHORT", or "HOLD" if setup is unclear or suboptimal.

Return ONLY a valid JSON object with EXACTLY this structure (no markdown fences, no explanatory text):
{
  "action": "ENTER_LONG" | "ENTER_SHORT" | "HOLD",
  "confidence": 0.85,
  "entry": ${input.symbolContext.price},
  "stopLoss": 0.0,
  "takeProfit": 0.0,
  "reason": "Brief technical rationale"
}`;
}
