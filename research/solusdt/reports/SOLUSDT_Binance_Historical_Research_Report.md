# SOLUSDT Historical Market Research

> Text extraction from `SOLUSDT_Binance_Historical_Research_Report.pdf` in the ChatGPT Library. Original PDF and duplicate DOCX were not uploaded as binary files in this commit.

SOLUSDT HISTORICAL RESEARCH | BINANCE USDⓈ-M PERPETUAL

HISTORICAL MARKET RESEARCH

SOLUSDT Perpetual
What the historical data supports, what is unproven, and what should not be
deployed yet
Data source: Binance public USDⓈ-M Futures market-data endpoints. Retrieval date: 12 October 2026.

Executive conclusion The daily data is useful for defining SOL volatility, tail risk and broad reversal behavior. It
does not yet establish a profitable SMC strategy or optimal dynamic stop/target policy. The cleanest result is
descriptive: median daily high-low range is about 5.61%, and 90th-percentile daily range about 10.58%. Treat these
as risk-distribution observations, not a forecast or recommended stop distance.




1. Scope, sample and data quality
Primary price sample: 999 daily SOLUSDT USDⓈ-M perpetual candles, 17 Jan 2024 through 11 Oct 2026 (UTC). The
current 12 Oct candle was excluded from closed-day statistics. Additional recent futures endpoints returned funding,
open-interest, taker-buy/sell and long/short series. The derivatives history available in this pass is shorter than the full
price sample.

 Dataset                                       Available sample                            Use / limitation
                                               999 completed daily candles, 17 Jan         Reliable for broad candle and range
 Daily OHLCV
                                               2024–11 Oct 2026                            statistics; not a trade backtest.
                                                                                           Some returned intraday bars produced
                                               Endpoint samples were inconsistent          implausible extreme single-bar returns;
 Intraday OHLCV
                                               across time windows                         those results were excluded from
                                                                                           conclusions.
                                               1,000 records, 1 Jan–30 Nov 2025 for the    Historical coverage is partial; not a
 Funding history
                                               detailed statistic                          complete 2024–2026 funding study.
                                               About 30 daily observations, mid-Sep–       Only a recent snapshot; far too small to
 Open interest / taker flow / ratios
                                               mid-Oct 2026                                prove a predictive relationship.
                                                                                           Cannot test true bid/ask imbalance or
                                               Not retrieved as a continuous historical
 Historical trades / order book                                                            complete aggressive order-flow patterns
                                               archive
                                                                                           here.


Data-quality caveat The intraday endpoint slices included implausible one-bar returns (for example, very large
percentage moves within a single 1h or 15m bar). These may reflect incomplete/misaligned slices or contract/data
semantics. Do not use those intraday measurements for execution conclusions until raw bars are continuity-
checked against Binance chart data.




2. Price behavior and volatility
 Metric                                        Observed result                             Interpretation
                                                                                           Near-even candle-color frequency.
 Bullish / bearish daily candles               501 bullish, 497 bearish, 1 doji            Candle color alone is not a directional
                                                                                           edge.
                                                                                           Half of observed daily close moves were
 Median absolute daily close-to-close
                                               2.36%                                       smaller in absolute terms; half were
 return
                                                                                           larger.
 75th percentile absolute daily close                                                      One quarter of absolute daily close
                                               4.26%
 return                                                                                    moves were around 4.26% or larger.
 90th percentile absolute daily close          6.38%                                       Large daily close moves are not rare
                                   Research note • Data retrieved 12 Oct 2026 • Not investment advice

SOLUSDT HISTORICAL RESEARCH | BINANCE USDⓈ-M PERPETUAL
 return                                                                                    enough to ignore in risk sizing.
 95th percentile absolute daily close                                                      Tail risk remains material; not a hard
                                                8.08%
 return                                                                                    maximum.
                                                                                           Daily intraday range is materially larger
 Median daily high-low range / open             5.61%
                                                                                           than many fixed tight stops.
 90th percentile daily high-low range /                                                    High-volatility days can have very large
                                                10.58%
 open                                                                                      wicks/ranges.
 95th percentile daily high-low range /                                                    Fixed stops must be tested against
                                                12.71%
 open                                                                                      volatility regime and entry location.
                                                                                           Observed extreme daily closes, not
 Largest daily close-to-close gain / loss       +24.42% / -20.48%
                                                                                           expected daily limits.
                                                                                           An extreme event; confirms that fixed
 Largest daily range                            37.62% on 10 Oct 2025                      daily movement caps are unsafe
                                                                                           assumptions.


What works Using rolling volatility/range percentiles to calibrate risk and size is justified as a research direction. A
volatility-aware system is better grounded than a universal fixed stop or an assumed 10% daily movement cap.


What does not work yet The data does not show that ATR stops, fixed stops, or trailing stops make more money.
Volatility percentiles describe how far price moved; they do not prove where to enter or exit.




3. Intraday reversal evidence from daily candles
For each daily candle, compare the day’s open and extremes with the final close. If a candle trades at least X% above
its open and closes below its open, it is counted as an up-then-red day. If it trades at least X% below its open and closes
above its open, it is counted as a down-then-green day. These are wick/body reversal proxies; OHLC daily candles
cannot reveal the exact time sequence of the move.

                                     High touched; bearish                                              Both sides touched
 Threshold beyond open                                                  Low touched; bullish close
                                     close                                                              threshold
 0.25%                               457 days                           445 days                        903 days (90.4%)
 0.50%                               413 days                           392 days                        803 days (80.4%)
 1.00%                               296 days                           295 days                        570 days (57.1%)
 1.50%                               199 days                           198 days                        349 days (34.9%)
 2.00%                               128 days                           145 days                        211 days (21.1%)


Interpretation Many SOL daily candles visit both sides of the open by meaningful thresholds. That warns against
assuming a simple early move will persist until close. But these counts do not determine whether an actual
long/short trade wins: entry time, stop order, target, fees and path order are missing.




4. Trend persistence and volatility regimes
 Finding                                        Observed result                            Conclusion
                                                                                           No useful bias from candle-color count
 Daily body direction                           501 green / 497 red / 1 flat
                                                                                           alone.
                                                                                           Streaks happen; this statistic alone does
 Consecutive same-color body streak             Maximum observed streak: 8 candles         not establish momentum or mean
                                                                                           reversion.
 Volatility bucket vs next/current daily        Positive-close share approximately 50%     No obvious directional edge in this
 return (rough descriptive split)               in each bucket                             simplistic split.
                                                                                           Need lagged features and forward
 Range expansion vs close direction             Not enough for a causal claim
                                                                                           returns, not same-candle measurements.




                                   Research note • Data retrieved 12 Oct 2026 • Not investment advice

SOLUSDT HISTORICAL RESEARCH | BINANCE USDⓈ-M PERPETUAL
The low/mid/high volatility bucket result is only exploratory. It used rolling daily ranges for classification and close-to-
close return summaries; it is not a predictive regime model and should not be interpreted as evidence that volatility
does not matter. A proper analysis would label regime at time t, then evaluate returns and strategy PnL strictly after t.



5. Derivatives context
Funding (partial archive)
 Statistic                                                           Observed result
 Retrieved sample                                                    1,000 funding records, 1 Jan–30 Nov 2025
 Positive funding observations                                       About 59.8%
 Negative funding observations                                       About 40.2%
 Median funding rate per record                                      About +0.00188%
 5th / 95th percentile per record                                    About -0.01371% / +0.01000%
 Observed minimum / maximum per record                               About -0.3028% / +0.0259%


Funding is a positioning/carry feature, not a standalone directional signal. Because this archive is incomplete, its
distribution should be recalculated from a full continuous funding history before using it in thresholds.

Recent positioning snapshot (approx. 13 Sep–12 Oct 2026)
 Metric                                        Start → end                                 What it says / does not say
                                                                                           Open contracts increased over this short
 Open interest, SOL units                      7.97M → 8.44M (+5.9%)
                                                                                           sample; not inherently bullish.
                                                                                           Includes both changes in contracts and
 Open-interest notional                        $810.8M → $939.6M (+15.9%)
                                                                                           price/valuation effects.
                                                                                           Recent aggressive flow was mixed,
 Daily taker buy/sell ratio                    0.953 → 1.032; 8/30 observations > 1
                                                                                           ending slightly buyer-dominant.
                                                                                           Accounts leaned net long in this
 Global long/short account ratio               2.315 → 2.377                               snapshot; crowding can be a risk, not a
                                                                                           buy signal.
                                                                                           Still net-long-leaning, slightly lower over
 Top-trader position ratio                     2.047 → 2.024
                                                                                           the sample.


What we cannot conclude Thirty daily observations do not establish that rising open interest, high long/short
ratios, or taker buy/sell imbalance predict price. The next test must align each feature at time t with forward
returns and simulated trades over fixed horizons, while avoiding look-ahead.




6. SMC setups and exit policies: status
 Candidate                                     Current evidence status                     Decision
                                               Not backtested from the screenshots or       Do not claim edge; define deterministic
 BOS continuation
                                               daily OHLCV aggregates                       swing/BOS rules and test out of sample.
                                                                                            Require objective pivot, confirmation
 CHoCH reversal                               Not backtested
                                                                                            and entry definitions.
                                              Daily wick proxies show reversals occur,      Test sweep distance, reclaim rule, stop
 Liquidity sweep
                                              not that a specific sweep strategy profits    and target; include fees.
                                                                                            Fill rate is not enough; measure forward
 FVG fill / reaction                          No reliable setup event series created        MFE/MAE and net expectancy after
                                                                                            retest.
                                                                                            Compare against direct breakout using
 Breakout + retest                            Not backtested
                                                                                            same dates and risk budget.
                                              Insufficient clean aligned intraday           Rebuild continuous bars first; then
 HTF alignment (1H/4H)
                                              history in this pass                          compare aligned vs conflicting regimes.
                                                                                            Keep all as candidates, not
 Fixed vs ATR vs trailing exits               No fair entry-matched simulation yet
                                                                                            recommendations.
                                   Research note • Data retrieved 12 Oct 2026 • Not investment advice

SOLUSDT HISTORICAL RESEARCH | BINANCE USDⓈ-M PERPETUAL




7. What appears useful vs. what does not
    Classification                                                 Evidence-based assessment
                                                                   Daily range/return percentiles for risk calibration and stress
    USEFUL / SUPPORTED                                             tests; explicit reversal-threshold counts as descriptive facts;
                                                                   strict no-trade conditions when data or structure is ambiguous.
                                                                   ATR-based sizing/stops; volatility regime routing;
    POTENTIALLY USEFUL / NEEDS TEST                                BOS/CHoCH/sweep/FVG/retest setups; funding, OI and taker
                                                                   flow as conditional filters; partial exits and trailing stops.
                                                                   Assuming green/red candle bias predicts the next day;
                                                                   assuming a fixed maximum daily move; asserting any SMC
    NOT SUPPORTED BY THIS PASS                                     label has a profitable edge; setting final SL/TP percentages from
                                                                   historical ranges alone; treating funding or long/short ratio as a
                                                                   standalone signal.
                                                                   Extreme single-bar intraday stats from the inconsistent
                                                                   returned intraday slices; apparent intraday setup or execution
    DO NOT TRUST YET
                                                                   results before timestamp continuity and candle integrity are
                                                                   verified.




8. Concrete next research pass
      Fix data ingestion first: retrieve continuous, bounded historical intraday windows and assert bar count,
       timestamp continuity, OHLC invariants (low <= open/close <= high), duplicate timestamps, and cross-timeframe
       consistency.
      Build a clean feature set: ATR, realized volatility, range percentiles, volume surprise, trend/pivot structure,
       funding, OI changes, long/short ratios and taker buy/sell imbalance. Persist features with their as-of timestamp.
      Define entries mechanically: exact swing/pivot lookback, BOS/CHoCH confirmation, sweep distance, FVG
       boundaries, retest tolerance, trigger candle and expiry window.
      Run entry-matched exit experiments: fixed R target, ATR stop/target, partial exit plus trail, breakeven activation
       and time stop. Use conservative same-bar stop/target precedence.
      Report net expectancy, profit factor, win rate, average win/loss, MFE/MAE, trade count, max drawdown, time in
       market and confidence intervals after fees/slippage/funding.
      Use a chronological train/validation/test split and walk-forward evaluation. Only promote rules that are robust
       across periods and do not depend on one extreme event.



9. Recommended system behavior from this pass
    Rule                                                           Recommendation
                                                                   Scale quantity with stop distance and account risk. Do not
    Risk sizing
                                                                   derive quantity from a fixed notional alone.
                                                                   Place stop based on setup invalidation, then use volatility to
    Stop placement                                                 reject entries whose required stop is too wide; do not blindly
                                                                   widen every stop to ATR.
                                                                   Test target multiples and structure exits under identical entries;
    Target logic                                                   do not assume 60% profit target or any fixed percentage is
                                                                   optimal.
                                                                   No trade when bars are incomplete/inconsistent, trigger is
    No-trade                                                       ambiguous, expected reward after costs is poor, or risk budget
                                                                   is exhausted.
                                                                   Use the model to summarize tool-returned features and state
    LLM role
                                                                   hypotheses. All numeric calculations, signals, sizing and

                                 Research note • Data retrieved 12 Oct 2026 • Not investment advice

SOLUSDT HISTORICAL RESEARCH | BINANCE USDⓈ-M PERPETUAL
                                                                      execution permissions remain deterministic and logged.




Appendix A. Definitions and reproducibility notes
   Daily close-to-close return: (close[t] / close[t-1] - 1) × 100.
   Daily candle range: (high - low) / open × 100.
   Up-then-red proxy at threshold x: high >= open × (1 + x/100) and close < open.
   Down-then-green proxy at threshold x: low <= open × (1 - x/100) and close > open.
   Both-sides proxy at threshold x: high >= open × (1 + x/100) and low <= open × (1 - x/100). It does not encode which
    extreme happened first.
   Funding percentages are reported per funding observation, not annualized. Funding record cadence can vary
    with exchange rules; do not multiply by a fixed number of periods without validating the interval.
   Intraday strategy performance is not reported because data integrity and complete entry/exit simulations were
    not established in this pass.
This report is a historical descriptive research note, not a live signal or a profitability guarantee. Binance public
market-data endpoints are subject to completeness, schema and historical-availability constraints. Validate every
downloaded data window before using the metrics for live trading decisions.




                                Research note • Data retrieved 12 Oct 2026 • Not investment advice