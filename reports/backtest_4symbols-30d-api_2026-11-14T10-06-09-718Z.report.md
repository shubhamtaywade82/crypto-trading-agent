# Backtest Report: backtest_4symbols-30d-api_2026-11-14T10-06-09-718Z

- **Window:** 2026-10-15T10:06:09.718Z -> 2026-11-14T10:06:09.718Z (30 days)
- **Symbols:** BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT
- **Generated:** 2026-11-14T10:07:03.893Z

## Headline Performance
| Metric | Value |
| :--- | :--- |
| **Net Return** | **-4.68%** (-53.84 USDT) |
| **Benchmark Return (Equal-Weight B&H)** | -21.56% |
| **Alpha (Excess vs Benchmark)** | **+16.88%** |
| **Total Trades** | 71 (31 partial take-profits) |
| **Win Rate** | 40.8% |
| **Gross Price PnL** | -30.59 USDT |
| **Final Equity** | 1096.16 USDT (Initial: 1150) |
| **Profit Factor** | 0.63 |
| **Expectancy** | -0.32 R / -0.76 USDT |
| **Max Drawdown** | 5.82% (67.69 USDT) |
| **Sharpe / Sortino** | -4.77 / -6.44 |
| **Friction / Fee Drag** | —% of gross profits (46.50 USDT) |

### By Symbol
| Key | Trades | Win Rate | Expectancy (R) | Net PnL (USDT) |
| :--- | ---: | ---: | ---: | ---: |
| `BTCUSDT` | 22 | 22.7% | -0.64R | -36.76 |
| `ETHUSDT` | 25 | 44% | -0.32R | -22.65 |
| `SOLUSDT` | 24 | 54.2% | -0.03R | 5.56 |

### By Strategy
| Key | Trades | Win Rate | Expectancy (R) | Net PnL (USDT) |
| :--- | ---: | ---: | ---: | ---: |
| `MEAN-REVERT-θ` | 15 | 53.3% | -0.30R | -22.95 |
| `MOMENTUM-γ` | 42 | 40.5% | -0.26R | -10.11 |
| `STRUCTURE-TREND-η` | 14 | 28.6% | -0.54R | -20.79 |

### By Regime
| Key | Trades | Win Rate | Expectancy (R) | Net PnL (USDT) |
| :--- | ---: | ---: | ---: | ---: |
| `HIGH_VOL` | 22 | 18.2% | -0.66R | -25.30 |
| `RANGE` | 15 | 53.3% | -0.30R | -22.95 |
| `TRANSITION` | 6 | 50% | -0.09R | 1.07 |
| `TREND_DOWN` | 25 | 56% | 0.00R | 4.75 |
| `TREND_UP` | 3 | 0% | -1.13R | -11.41 |

### By Evidence Bucket
| Key | Trades | Win Rate | Expectancy (R) | Net PnL (USDT) |
| :--- | ---: | ---: | ---: | ---: |
| `00-50` | 32 | 46.9% | -0.08R | 6.57 |
| `50-70` | 34 | 41.2% | -0.42R | -28.85 |
| `70-88` | 5 | 0% | -1.17R | -31.56 |