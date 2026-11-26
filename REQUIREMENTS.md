Worked for 11m 58s

### Binance publicly accessible REST endpoints

I extracted the routes from your 23 uploaded Binance API collections, containing 698 REST operations, and checked the security classifications against Binance’s current developer documentation.

99 no-auth endpoints19 API-key-only endpoints698 source operations

The distinction matters: Binance classifies endpoints as `NONE` (no authentication), `MARKET_DATA` (API key required, no signature), or signed/private operations. An API-key-only market-data endpoint is not the same as a no-auth public endpoint. Binance Developer Docs

### 1\. Public endpoints — no API key or signature

All 99 routes below use `GET`.

### Alpha Trading — 6

Base URL: `https://www.binance.com`

```text
GET /bapi/defi/v1/public/alpha-trade/agg-trades
GET /bapi/defi/v1/public/alpha-trade/fullDepth
GET /bapi/defi/v1/public/alpha-trade/get-exchange-info
GET /bapi/defi/v1/public/alpha-trade/klines
GET /bapi/defi/v1/public/alpha-trade/ticker
GET /bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list
```

`fullDepth` is included from Binance's current developer documentation; it was not present in your uploaded Alpha collection. Binance Developer Docs

### COIN-M Futures — 25

Base URL: `https://dapi.binance.com`

```text
GET /dapi/v1/aggTrades
GET /dapi/v1/constituents
GET /dapi/v1/continuousKlines
GET /dapi/v1/depth
GET /dapi/v1/exchangeInfo
GET /dapi/v1/fundingInfo
GET /dapi/v1/fundingRate
GET /dapi/v1/indexPriceKlines
GET /dapi/v1/klines
GET /dapi/v1/markPriceKlines
GET /dapi/v1/openInterest
GET /dapi/v1/ping
GET /dapi/v1/premiumIndex
GET /dapi/v1/premiumIndexKlines
GET /dapi/v1/ticker/24hr
GET /dapi/v1/ticker/bookTicker
GET /dapi/v1/ticker/price
GET /dapi/v1/time
GET /dapi/v1/trades
GET /futures/data/basis
GET /futures/data/globalLongShortAccountRatio
GET /futures/data/openInterestHist
GET /futures/data/takerBuySellVol
GET /futures/data/topLongShortAccountRatio
GET /futures/data/topLongShortPositionRatio
```

### Convert — 1

Base URL: `https://api.binance.com`

```text
GET /sapi/v1/convert/exchangeInfo
```

### Options — 12

Base URL: `https://eapi.binance.com`

```text
GET /eapi/v1/blockTrades
GET /eapi/v1/depth
GET /eapi/v1/exchangeInfo
GET /eapi/v1/exerciseHistory
GET /eapi/v1/index
GET /eapi/v1/klines
GET /eapi/v1/mark
GET /eapi/v1/openInterest
GET /eapi/v1/ping
GET /eapi/v1/ticker
GET /eapi/v1/time
GET /eapi/v1/trades
```

### Portfolio Margin — 1

Base URL: `https://papi.binance.com`

```text
GET /papi/v1/ping
```

### Spot — 19

Base URL: `https://api.binance.com`

```text
GET /api/v3/aggTrades
GET /api/v3/avgPrice
GET /api/v3/depth
GET /api/v3/exchangeInfo
GET /api/v3/executionRules
GET /api/v3/historicalBlockTrades
GET /api/v3/historicalTrades
GET /api/v3/klines
GET /api/v3/ping
GET /api/v3/referencePrice
GET /api/v3/referencePrice/calculation
GET /api/v3/ticker
GET /api/v3/ticker/24hr
GET /api/v3/ticker/bookTicker
GET /api/v3/ticker/price
GET /api/v3/ticker/tradingDay
GET /api/v3/time
GET /api/v3/trades
GET /api/v3/uiKlines
```

The current Spot REST documentation says an endpoint with no explicitly specified security type defaults to `NONE`. This is why `/api/v3/historicalTrades` is included in this list, despite the generic API-key header appearing in your Postman collection. Binance Developer Docs

### USDⓈ-M Futures — 34

Base URL: `https://fapi.binance.com`

```text
GET /fapi/v1/aggTrades
GET /fapi/v1/assetIndex
GET /fapi/v1/constituents
GET /fapi/v1/continuousKlines
GET /fapi/v1/convert/exchangeInfo
GET /fapi/v1/depth
GET /fapi/v1/exchangeInfo
GET /fapi/v1/fundingInfo
GET /fapi/v1/fundingRate
GET /fapi/v1/indexInfo
GET /fapi/v1/indexPriceKlines
GET /fapi/v1/insuranceBalance
GET /fapi/v1/klines
GET /fapi/v1/markPriceKlines
GET /fapi/v1/openInterest
GET /fapi/v1/ping
GET /fapi/v1/premiumIndex
GET /fapi/v1/premiumIndexKlines
GET /fapi/v1/rpiDepth
GET /fapi/v1/symbolAdlRisk
GET /fapi/v1/ticker/24hr
GET /fapi/v1/ticker/bookTicker
GET /fapi/v1/ticker/price
GET /fapi/v1/time
GET /fapi/v1/trades
GET /fapi/v1/tradingSchedule
GET /fapi/v2/ticker/price
GET /futures/data/basis
GET /futures/data/delivery-price
GET /futures/data/globalLongShortAccountRatio
GET /futures/data/openInterestHist
GET /futures/data/takerlongshortRatio
GET /futures/data/topLongShortAccountRatio
GET /futures/data/topLongShortPositionRatio
```

### Wallet — 1

Base URL: `https://api.binance.com`

```text
GET /sapi/v1/system/status
```

### 2\. Public market data, but API key required — 19

These are not signed trading or account operations, but Binance marks them as `MARKET_DATA`. They require `X-MBX-APIKEY`; they do not require a request signature.

| Product              | Method and endpoint                              |
|----------------------|--------------------------------------------------|
| COIN-M Futures       | GET /dapi/v1/historicalTrades                    |
| Margin               | GET /sapi/v1/margin/allAssets                    |
| Margin               | GET /sapi/v1/margin/allPairs                     |
| Margin               | GET /sapi/v1/margin/crossMarginCollateralRatio   |
| Margin               | GET /sapi/v1/margin/delist-schedule              |
| Margin               | GET /sapi/v1/margin/isolated/allPairs            |
| Margin               | GET /sapi/v1/margin/leverageBracket              |
| Margin               | GET /sapi/v1/margin/limit-price-pairs            |
| Margin               | GET /sapi/v1/margin/list-schedule                |
| Margin               | GET /sapi/v1/margin/priceIndex                   |
| Margin               | GET /sapi/v1/margin/restricted-asset             |
| Margin               | GET /sapi/v1/margin/risk-based-liquidation-ratio |
| Mining               | GET /sapi/v1/mining/pub/algoList                 |
| Mining               | GET /sapi/v1/mining/pub/coinList                 |
| Portfolio Margin Pro | GET /sapi/v1/portfolio/asset-index-price         |
| Portfolio Margin Pro | GET /sapi/v1/portfolio/collateralRate            |
| USDⓈ-M Futures       | GET /fapi/v1/historicalTrades                    |
| Wallet               | GET /sapi/v1/spot/delist-schedule                |
| Wallet               | GET /sapi/v1/spot/open-symbol-list               |

Binance explicitly documents the API-key requirement for the COIN-M historical-trades endpoint. Binance Developer Docs

### 3\. Recommended Spot public-data base URL

For Spot public market data, Binance also offers:

```text
https://data-api.binance.vision
```

This host does not require an API key, but it supports a specific subset of Spot endpoints, not all 19 Spot routes above:

```text
GET /api/v3/aggTrades
GET /api/v3/avgPrice
GET /api/v3/depth
GET /api/v3/exchangeInfo
GET /api/v3/klines
GET /api/v3/ping
GET /api/v3/ticker
GET /api/v3/ticker/24hr
GET /api/v3/ticker/bookTicker
GET /api/v3/ticker/price
GET /api/v3/time
GET /api/v3/trades
GET /api/v3/uiKlines
```

Binance documents this host specifically for unauthenticated public market data. Binance Developer Docs

### 4\. Download the complete endpoint catalog

I generated machine-readable catalogs containing endpoint paths, methods, base URLs, product families, security classifications, and source collection names.

CSV endpoint catalog

Easy to filter, import into Excel, or use for API inventory work.

118 rows

Download CSV

JSON endpoint catalog

Structured data for programmatic processing and integration.

Download JSON

Markdown endpoint catalog

Readable reference grouped by Binance product.

Download Markdown

### 5\. Scope and security notes

This is a REST API inventory based on the 23 uploaded collections, with the current Alpha `fullDepth` endpoint added from Binance's developer documentation. It does not include WebSocket streams, WebSocket API methods, FIX, or Binance product APIs for which no collection was supplied. Binance documents these as separate API surfaces. Binance Developer Docs +1

For implementation, don't attach `X-MBX-APIKEY` indiscriminately to every request just because it appears in the Postman collections. Use the endpoint's actual security classification:

* `NONE`: no API key or signature.

* `MARKET_DATA`: API key, no signature.

* `TRADE`, `USER_DATA`, `MARGIN`: API key and signature.

* `USER_STREAM`: API key for listen-key management; not public.

For a trading-data ingestion service, start with the 99 `NONE` endpoints. Add the 19 key-only endpoints only when you need their additional datasets.
No. The previous catalog contains REST endpoints only. It does not contain Binance public WebSocket streams.

Binance exposes public market data through separate WebSocket connections. These should be catalogued independently.

For your crypto trading infrastructure, we should cover the following.

### 1\. Public WebSocket API families

Spot

Public market data

`wss://stream.binance.com:9443/ws`

`wss://stream.binance.com:9443/stream`

USDⓈ-M Futures

Public market data

`wss://fstream.binance.com/ws`

`wss://fstream.binance.com/stream`

COIN-M Futures

Public market data

`wss://dstream.binance.com/ws`

`wss://dstream.binance.com/stream`

Options

Public market data

`wss://nbstream.binance.com/eoptions/ws`

Alpha Trading

Requires its own Alpha market-data WebSocket documentation and connection details; it should not be assumed to share Spot streams.

### 2\. Public WebSocket stream categories

| Category                | Example stream                                         |
|-------------------------|--------------------------------------------------------|
| Aggregate trades        | btcusdt@aggTrade                                       |
| Individual trades       | btcusdt@trade                                          |
| Candlesticks            | btcusdt@kline_1m                                       |
| Order book depth        | btcusdt@depth                                          |
| Partial order book      | btcusdt@depth20                                        |
| Best bid/ask            | btcusdt@bookTicker                                     |
| 24h ticker              | btcusdt@ticker                                         |
| Mini ticker             | btcusdt@miniTicker                                     |
| Rolling window ticker   | btcusdt@ticker_1h                                      |
| Mark price              | btcusdt@markPrice                                      |
| Funding rate            | btcusdt@markPrice@1s                                   |
| Liquidations            | btcusdt@forceOrder                                     |
| Open interest           | REST endpoint; not a standard individual public stream |
| All market mini tickers | !miniTicker@arr                                        |
| All market tickers      | !ticker@arr                                            |
| All liquidation orders  | !forceOrder@arr                                        |

These are representative stream names, not an exhaustive inventory.

### 3\. What I recommend adding to the Binance API catalog

We should create a unified catalog with four distinct API surfaces:

| API surface       | Coverage                                           |
|-------------------|----------------------------------------------------|
| REST              | Public and authenticated endpoints                 |
| WebSocket Streams | Public and private event streams                   |
| WebSocket API     | Request/response methods over WebSocket            |
| FIX               | Trading and market-data interfaces where supported |

For each WebSocket stream, capture:

* Product and market (Spot, USDⓈ-M, COIN-M, Options).

* Base connection URL.

* Stream name and subscription syntax.

* Event payload schema.

* Update frequency.

* Snapshot/delta semantics.

* Sequence numbers and synchronization requirements.

* Connection limits and subscription limits.

* Authentication requirements.

* Reconnection and resubscription behavior.

Important for your trading engine: Order-book streams must include snapshot synchronization, update-ID continuity checks, and recovery after sequence gaps. Simply consuming `depth` events is not sufficient to maintain a correct local order book.

### 4\. Proposed deliverable

I recommend extending the previous endpoint catalog into a complete Binance Market Data API Registry.

It should include all public REST endpoints and public WebSocket streams, with machine-readable JSON and CSV outputs.

Would you like me to build the complete registry across Spot, USDⓈ-M Futures, COIN-M Futures, Options, and Alpha, including individual stream payload schemas and subscription examples?

Worked for 1m 8s

I’ll build a Binance public market-data API registry covering the five main market families: Spot, USDⓈ-M Futures, COIN-M Futures, Options, and Alpha.

The registry will distinguish three interfaces that are easy to conflate:

* WebSocket Streams — persistent public feeds such as trades, klines, order-book updates, tickers and mark prices.

* WebSocket API — request/response methods over WebSocket, including public market-data methods where supported.

* FIX — a separate protocol surface; I’ll identify its public market-data scope rather than treating it as a WebSocket stream.

I’ll also separate public unauthenticated access from API-key-required access. “Public market data” does not automatically mean every endpoint or connection is anonymous.

Created the registry and exported it in three formats.

Binance WebSocket registry

Generated

### 99

Registry entries covering stream templates and protocol surfaces

Markdown documentation

Descriptions, examples, operational guidance and references

Download

JSON registry

Structured data for application integration

Download

CSV registry

Spreadsheet and database import

Download

Previous REST inventory

Download REST endpoint CSV · JSON · Markdown

### Coverage

| Product        | Public WebSocket coverage                                              |
|----------------|------------------------------------------------------------------------|
| Spot           | Trades, aggregate trades, klines, tickers, book ticker, depth          |
| USDⓈ-M Futures | Trades, klines, mark/index price, funding, depth, liquidation, tickers |
| COIN-M Futures | Trades, klines, mark/index price, depth, liquidation, tickers          |
| Options        | Option trades, tickers, depth, underlying mark price, open interest    |
| Alpha          | Token trades, klines, tickers, book ticker, partial/full depth         |

The registry also identifies the separate WebSocket API surfaces and Spot FIX market-data interface.

### Important findings for implementation

1\. Don't treat all Binance WebSockets as the same protocol.

Spot, Futures, Options and Alpha have different connection hosts, stream naming conventions, payloads and operational limits.

2\. USDⓈ-M has a URL migration to account for.

Binance's 2026 change log identifies `/public` and `/market` paths for market streams and `/private` for user-data streams. The registry flags this rather than assuming legacy URLs are universally valid. Binance 开发者文档

3\. Order-book synchronization is critical.

For incremental depth streams, the correct implementation is:

* Subscribe and buffer depth events.

* Fetch a REST order-book snapshot.

* Bridge the snapshot update ID to the buffered events.

* Apply updates in sequence.

* Rebuild the book if a sequence gap occurs.

Otherwise, your local order book can become silently incorrect. GitHub +1

4\. FIX is not anonymous public access.

Spot FIX Market Data requires an API key with `FIX_API` or `FIX_API_READ_ONLY` permissions. GitHub

### One scope limitation

This is a registry of documented stream families and parameterized templates, not every possible symbol/interval combination. Options schemas and the latest USDⓈ-M URL paths need a final per-stream verification before production integration.

### Recommended next step

For your trading infrastructure, the logical next deliverable is a unified market-data ingestion architecture: one normalized event model across Spot, USDⓈ-M, COIN-M, Options and Alpha, with sequence-aware order books, reconnect management, historical REST backfill and durable event storage.

https://github.com/shubhamtaywade82/binance-sdk
Good news: everything in your two marketplace chapters maps directly onto Binance's public feeds, and the whole system can be built as one deterministic pipeline. One honest framing note before the architecture —

**Know your alpha's half-life.** Order book imbalance, CVD, absorption — these features are predictive over seconds to minutes, occasionally up to an hour. For intraday scalping they're the signal itself. For swing trading they're *not* the thesis; use them for (a) execution timing and (b) aggregated context (session order flow, cumulative CVD slope, funding/open-interest for futures). Designing both from one engine is exactly what the deterministic architecture below gives you.

## Architecture

```
Binance WS (diff depth @100ms, aggTrade, bookTicker, kline)
        │  raw messages
        ▼
┌───────────────────────────────────────┐
│ Ingestion layer (asyncio)             │  reconnect, buffering, gap detect
│ → raw event log (JSONL/Parquet)  ◄────│  this log is your ground truth
└───────────────────────────────────────┘
        │  ordered events
        ▼
┌───────────────────────────────────────┐
│ Book state builder (event-sourced)    │  snapshot + diff application
│ bids/asks dicts, per-level qty        │  single writer per symbol
└───────────────────────────────────────┘
        │  state + events
        ▼
┌───────────────────────────────────────┐
│ Feature engine (pure functions)       │  imbalance, microprice, CVD,
│ emits features @ tick or @ 100ms      │  absorption, cancel ratio…
└───────────────────────────────────────┘
        │
        ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│ Signal layer │──▶│ Risk mgmt    │──▶│ Execution (REST) │  testnet first
└──────────────┘   └──────────────┘   └──────────────────┘
        ▲
        └── replay engine feeds the SAME code with recorded data → backtest == live
```

## The correctness-critical piece: snapshot + diff sync

This is where every beginner's book builder breaks. You can't build the book from the diff stream alone — you bootstrap with a REST snapshot, then apply buffered diffs, and **re-snapshot on any gap**. Futures diffs include `pu` (previous update ID), making gap detection trivial:

```python
import asyncio, aiohttp

BASE, WS = "https://fapi.binance.com", "wss://fstream.binance.com/stream"

class BookBuilder:
    def __init__(self, symbol: str, depth: int = 500):
        self.symbol, self.depth = symbol, depth
        self.bids, self.asks = {}, {}     # price -> qty, best at min/max
        self.last_u = 0                   # last applied update id
        self.synced = False
        self._buf = []

    async def bootstrap(self, sess):
        async with sess.get(f"{BASE}/fapi/v1/depth",
                            params={"symbol": self.symbol, "limit": 1000}) as r:
            s = await r.json()
        self.bids = {float(p): float(q) for p, q in s["bids"]}
        self.asks = {float(p): float(q) for p, q in s["asks"]}
        self._trim()
        self.last_u, self.synced = s["lastUpdateId"], True

    def _trim(self):
        # keep only `depth` best levels on each side
        for side, rev in ((self.bids, True), (self.asks, False)):
            for p in sorted(side, reverse=rev)[self.depth:]:
                del side[p]

    async def on_diff(self, ev):          # ev = <symbol>@depth event
        if not self.synced:
            self._buf.append(ev)
            if ev["u"] >= self._snap_id:  # snapshot's lastUpdateId known by caller
                await self.bootstrap(self._sess)
                for e in self._buf:       # drop stale, apply the rest
                    if e["u"] >= self._snap_id:
                        self._apply(e)
                self._buf.clear()
            return
        if ev["pu"] != self.last_u:       # gap → rebuild
            self.synced = False
            return
        self._apply(ev)

    def _apply(self, ev):
        for p, q in ev["b"]:
            self._upd(self.bids, float(p), float(q))
        for p, q in ev["a"]:
            self._upd(self.asks, float(p), float(q))
        self.last_u = ev["u"]

    @staticmethod
    def _upd(side, price, qty):           # qty == 0 → level pulled (cancel/fill)
        if qty == 0:
            side.pop(price, None)
        else:
            side[price] = qty

    @property
    def best(self):
        return max(self.bids), min(self.asks)
```

Rules this enforces (futures version): drop buffered events older than the snapshot (`u < lastUpdateId`), first applied event must satisfy `U ≤ lastUpdateId+1 ≤ u`, then every event's `pu` must equal the previously applied `u`. For spot, replace the `pu` check with `U == last_u + 1`. Combined stream URL: `wss://fstream.binance.com/stream?streams=btcusdt@depth@100ms/btcusdt@aggTrade/btcusdt@bookTicker`.

## Determinism: event sourcing

The entire design principle: **never compute state from anything except the raw event log.** Every layer is a pure fold over events:

1. Recorder writes every WS message with receipt timestamp to append-only files (one per stream per hour — JSONL, compact to Parquet daily).
2. State builder = pure function `(state, event) → state`.
3. Features = pure function `(state, event) → feature vector`.
4. Replay engine feeds recorded files through layers 2–3. **If replay doesn't reproduce your live features bit-for-bit, you have a bug** — this assertion is your best testing tool.
5. "Past data" problem: historical trades/klines/book snapshots come from Binance Vision (data.binance.vision); from day one, your recorder accumulates the high-fidelity depth+trade data you can never download later. Start recording before you start strategizing.

## Feature engine — your marketplace chapters, as formulas

| Chapter concept                               | Deterministic feature                                                                                                          |
|-----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| Bid vs ask                                    | `imbalance_k = (ΣbidQty − ΣaskQty) / (ΣbidQty + ΣaskQty)` over top k levels, plus its first derivative (is pressure building?) |
| True fair price                               | `microprice = (ask₁·qb₁ + bid₁·qa₁)/(qb₁+qa₁)`, deviation from mid in bps                                                      |
| Spread                                        | absolute, bps, and rolling z-score (widening = uncertainty, per your ch. 1)                                                    |
| Depth / thin board                            | total qty within ±5/10/25 bps of mid; level count; "board resilience" = refill rate of consumed levels within N ms             |
| Aggressive buying/selling (ch. 2)             | from aggTrade: `m=false` → buyer is taker → buy-initiated volume; maintain **CVD** (cumulative volume delta)                   |
| Absorption                                    | large sell-initiated qty while mid unchanged + bids refill → selling is being eaten                                            |
| Buyers pulling orders (ch. 2 collapse step 2) | **cancel ratio**: qty removed at a level with no matching trade prints; a level vanishing without trades is a pull, not a fill |
| Iceberg heuristic                             | a price level whose qty never drops despite large prints at it (refilled faster than trade flow explains)                      |
| Liquidity vacuum (ch. 2 cascade)              | depth-within-X-bps collapsing below rolling percentile + CVD accelerating in one direction                                     |
| Activity/regime                               | messages/sec on the depth stream, trade count/sec, realized vol from trade prices                                              |

Emit features every diff event *and* on a fixed 100ms/1s clock — event-driven for precision, clock-driven for ML/aggregation convenience.

## Signal layer (examples to validate first)

- **Absorption scalp**: CVD making new lows + price flat + bid refill → fade the selling.
- **Continuation**: imbalance and CVD aligned, spread tight, depth sloped against the move → join it.
- **Sweep reversal**: aggressive marketable order walks through 3+ levels, then price reclaims the level within seconds → trapped participants unwind.
- **Regime gate**: only take scalps when book update rate is above median; stand down in dead books (your own ch. 2 lesson: same selling, different outcome).

## Ops notes

- Run spot (`stream.binance.com`) vs futures (`fstream.binance.com`) deliberately — futures adds funding, OI, and mark price streams, which matter for swing context. Use **testnet** (`testnet.binancefuture.com`) for execution dev.
- REST depth snapshots are weight-limited — cache them, and note the gap handler is your self-healing mechanism, not a failure path.
- Monitor stream lag: `E` (event time) vs receipt wall-clock; sustained lag > a few hundred ms means you should shed symbols, not trade on stale books.
- Pick 2–3 liquid symbols (e.g., BTCUSDT, ETHUSDT, SOLUSDT). Depth × 100ms × features is already a serious data rate; scaling to 50 symbols is an infra project, not a config change.

## Suggested build order

1. Recorder + clock-sync + storage format
2. Book builder + replay harness with the equality assertion
3. Feature engine on recorded data → explore *before* writing strategies
4. Backtest the candidate signals on replays (intrabar fills at next-tick price, include fees/slippage from the book itself — you literally have per-level depth to model slippage honestly)
5. Paper on testnet, then live with tiny size

One integration note: your AlgoScalperApi project is Ruby on Rails 8.1.3 wired to Dhan via the DhanHQ 2.8.0 gem — that gem won't talk to Binance, so build this as a standalone Python service (asyncio is the natural fit) that publishes signals to your Rails app over Redis/HTTP, with Rails keeping its current role of orchestration, risk limits, and alerting (you already have Redis, Solid Queue, and telegram-bot-ruby in the stack for that).

Want me to write the full runnable skeleton — recorder, book builder, feature engine, and replay harness as a project you can start recording with today?
This is a solid foundation — and yes, the natural next step is exactly what your last section proposes: a unified, machine-readable registry covering all four public WebSocket surfaces (and the WebSocket API as a distinct surface). I'll build it. First, two quick checks on details that have changed over time (update-speed tiers and connection limits), then I'll generate the JSON/CSV/Markdown deliverables.
Both details confirmed: Spot allows 1,024 streams per connection, 300 connection attempts/5 min/IP, and 5 incoming messages/sec; derivatives depth streams now have 100/250/500 ms tiers, and there's a new `<symbol>@rpiDepth@500ms` stream on USDⓈ-M (added 2025-11-19). Now building the registry files.
Yes — built it. The complete registry is done, extending your REST catalog with the full public WebSocket surface across Spot, USDⓈ-M, COIN-M, and Options, plus the WebSocket API as a separate surface.

**What's inside (42 stream entries + limits + WS API):**

- **Every public stream per product**, with update frequency, all-market variant (`!ticker@arr`, `!bookTicker`, etc.), payload field schema, and sync requirements. Key verified details:
  - Depth streams exist in **100/250/500 ms tiers** on all derivatives products; Spot defaults to 1000 ms with `@100ms` speedups.
  - Spot limits confirmed: **1,024 streams per connection, 300 connection attempts/5 min/IP, 5 incoming msgs/sec** — note it's 5 msgs/sec for Spot, not 10.
  - A new USDⓈ-M stream `<symbol>@rpiDepth@500ms` (RPI-inclusive depth) was added on 2025-11-19, and post-CM-migration depth payloads carry extra `st`/`ps` fields — both captured in the registry.
  - Options depth is now a **diff stream** at 100/500 ms tiers, so it needs the same snapshot/continuity discipline as the futures books.
- **Order-book sync quick reference** distilled into the registry: the exact `U/u/pu` rules per product, since — as your own analysis noted — consuming `@depth` without snapshot pairing produces a silently corrupted book.
- **FIX** is recorded as a surface but explicitly excluded from the public registry (no unauthenticated FIX market data; Spot FIX is a trading interface).

**For your trading engine, the minimal subscription set per symbol** falls straight out of the registry: `<symbol>@depth@100ms` + REST snapshot (book state), `<symbol>@aggTrade` (CVD / buyer-vs-seller initiation), `<symbol>@bookTicker` (top-of-book cross-check), `<symbol>@forceOrder` (liquidation cascades on futures), and `<symbol>@markPrice@1s` + `<symbol>@kline_1m` (swing context).

Files:

-  — full machine-readable registry (streams, limits, base URLs, WS API, sync rules)
-  — flat stream catalog for filtering/Excel
-  — connection/rate limits per product
-  — human-readable reference

One caveat carried in the registry itself: rows marked `verify` (mostly fine-grained frequencies and the non-Spot connection limits) are best-effort — Spot limits and the derivatives depth tiers are the ones I confirmed against current docs in this session. Next step if you want it: a subscriber module that reads this JSON registry and spins up the exact stream set per symbol — that would complete the loop from catalog to running recorder.



how can we use order book, depth, and trades endpoints and websockets in nodejs+typescript to build this intraday + swing + hft bot complete deterministic rule engine

Below is a complete, evidence-verified engineering plan and a runnable TypeScript core. Before the architecture, three findings from the current documentation materially change the registry produced earlier in this thread, so I verified them first.

---

## 0. Verified corrections before writing any code

**0.1 — Correction (measured 2026-11-26, public, no key, 12 s windows).** The legacy root still streams `@trade`: `wss://fstream.binance.com/ws/btcusdt@trade` delivered 141 messages. `wss://fstream.binance.com/market/ws/btcusdt@trade` delivered none. `/market` `@aggTrade` (57) and `@markPrice@1s` (11) stream, and `/public/ws/btcusdt@bookTicker` streams (2008). The tick feed keeps the legacy root for `@trade` (`src/binance/client.ts`, `usdmTradeWsUrl`). Re-probe before changing it. The earlier text that said the legacy roots were dead is withdrawn for `@trade`.

| Route      | Streams                                                                                                            | Base URL                                                                                    |
|------------|--------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `/public`  | `@depth`, `@depth<levels>`, `@bookTicker`, `!bookTicker`                                                           | `wss://fstream.binance.com/public/stream?streams=…`                                         |
| `/market`  | `@aggTrade`, `@kline_*`, `@markPrice`, `@ticker`, `@miniTicker`, `@forceOrder`, `@compositeIndex`, `!contractInfo` | `wss://fstream.binance.com/market/stream?streams=…`                                         |
| `/private` | User data (`listenKey` + `events`)                                                                                 | `wss://fstream.binance.com/private/ws?listenKey=…&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE` |

This mapping is documented explicitly, including the failure mode where `…/ws/btcusdt@markPrice` stops working while `…/ws/btcusdt@depth` continues . COIN-M has **not** migrated: its current Connect page still specifies `wss://dstream.binance.com/ws` and `/stream` .

**0.2 — Current connection limits (verified against the live docs, not the older changelog entries):**

| Parameter                    | USDⓈ-M / COIN-M                    | Spot                                                       |
|------------------------------|------------------------------------|------------------------------------------------------------|
| Max streams per connection   | **1024** (raised from the old 200) | 1024                                                       |
| Incoming client messages/sec | 10                                 | 5 (PING/PONG/JSON control all count)                       |
| Server ping / required pong  | every 3 min / within 10 min        | every 20 s / within 60 s, pong must copy payload           |
| Connection lifetime          | 24 h                               | 24 h, plus a `serverShutdown` event with shutdown time `T` |
| Connection attempts          | per-IP throttle                    | 300 per 5 min per IP                                       |
| Depth diff tiers             | 250 ms default, `@500ms`, `@100ms` | 1000 ms default, `@100ms`                                  |

Spot additionally supports `timeUnit=MICROSECOND` on the stream URL and a market-data-only host `wss://data-stream.binance.vision` . `GET /fapi/v1/rpiDepth` and `<symbol>@rpiDepth@500ms` were indeed added on 2025-11-19, confirming that registry row .

**0.3 — The exact order-book synchronization rules differ by product, and both are now confirmed verbatim:**

- **USDⓈ-M:** buffer diffs → snapshot `GET /fapi/v1/depth?limit=1000` → drop events with `u < lastUpdateId` → first processed event must satisfy `U ≤ lastUpdateId AND u ≥ lastUpdateId` → thereafter every event's `pu` must equal the previous event's `u`, else restart from the snapshot step; quantities are absolute, `0` removes a level, and removing a non-existent level is normal .
- **Spot:** note the first buffered `U`; snapshot `limit=5000`; if snapshot `lastUpdateId < U` of the first buffered event, re-fetch; drop events with `u ≤ lastUpdateId`; the first event's `[U, u]` must contain `lastUpdateId`; thereafter `U == previous u + 1`; if `U > localId + 1`, discard the book and restart from the beginning .

**0.4 — Latency surfaces, honestly ranked.** The futures WebSocket API (`wss://ws-fapi.binance.com/ws-fapi/v1`, testnet `wss://testnet.binancefuture.com/ws-fapi/v1`) supports `order.place` over a persistent connection with Ed25519 `session.logon`; its `ORDERS` rate limit is shared with REST while `REQUEST_WEIGHT` is a separate per-IP pool . Spot offers SBE binary market data at `stream-sbe.binance.com` with **20 ms diff depth, 50 ms top-20 snapshots, and microsecond timestamps**, but it requires an Ed25519 API key in the handshake header (no signature) — it is not anonymous access . Futures testnet streams live at `wss://fstream.binancefuture.com` .

**HFT framing:** with no retail colocation, your floor is region RTT plus the 100 ms JSON depth cadence on futures. Deploy in AWS `ap-northeast-1` (Tokyo) and treat the "HFT" tier as **100 ms reactive scalping**, not microsecond market-making. Also note `aggTrade` gives no queue position, so maker-fill modeling must be conservative. The architecture below is honest about all three tiers: same engine, three rule packs.

---

## 1. The determinism contract

Seven invariants. Everything else is implementation detail.

| #  | Invariant                                                                                                           | Enforcement                                                                                                                                              |
|----|---------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| D1 | The append-only raw log is the only source of truth. All state is a left fold over it.                              | Recorder writes **every** input: WS frames, REST snapshot bodies, health samples, fills, config/meta.                                                    |
| D2 | Book state uses integer ticks/lots parsed exactly from decimal strings. No float arithmetic in state.               | `exchangeInfo` `PRICE_FILTER`/`LOT_SIZE` → integer grid; off-grid values throw.                                                                          |
| D3 | One writer per symbol; total order = recorder sequence number.                                                      | Symbol actor owns its book, features, rule state.                                                                                                        |
| D4 | No `Date.now()`, `Math.random()`, or unordered iteration inside the core. Timers advance on **event time**.         | Wall-clock-dependent values (lag, queue depth) are sampled at the edge and **written into the log as `health` events**, so replay sees identical inputs. |
| D5 | Config is versioned and SHA-256 hashed; every decision embeds `configHash`, `ruleId`, frame hash, triggering `seq`. | Decision log is the audit trail.                                                                                                                         |
| D6 | Live ≡ replay, bit-for-bit.                                                                                         | CI gate: replayed frame/decision hashes must equal the live-recorded hashes.                                                                             |
| D7 | Impure I/O only at the edges (WS, REST, FS, execution). Core packages have zero runtime dependencies.               | Package boundary lint rule.                                                                                                                              |

D1 has a consequence most implementations miss: **REST depth-snapshot responses must be recorded into the same per-symbol log**, otherwise replay cannot reproduce the bridge deterministically.

---

## 2. Architecture

```
/public/stream (depth@100ms, bookTicker)   /market/stream (aggTrade, markPrice@1s,
        │                                   kline_1m, forceOrder)      /private (fills)
        ▼                                          ▼                        ▼
┌──────────────────────── ingest edge (impure) ────────────────────────────────┐
│ ws shards: reconnect, 23h recycle, watchdog, lag sampling                     │
│ REST: exchangeInfo, time, depth snapshots (weight-budgeted)                   │
│ recorder: per-symbol JSONL, seq + recvNs, hourly rotation, sha256 manifest    │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   ▼  LogEvent (totally ordered per symbol)
┌──────────────────────── symbol actor (pure fold, single writer) ─────────────┐
│ Book (U/u/pu state machine) → Features (event-time buckets) → Rules (AST,     │
│ hysteresis, cooldown) → Risk (gates, caps, kill) → DecisionRecord             │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   ▼  approved Intent (deterministic clientOrderId)
                        execution edge: REST / ws-fapi order.place (Ed25519)
                                   │
                        fills → logged → portfolio fold (closes the loop)

replay CLI: same fold over the JSONL → assert hash(frames_live) == hash(frames_replay)
backtest:   same fold + simulated executor (depth-walk slippage, conservative maker fills)
Ollama (nemesis-crypto-agent): offline advisory only — proposes config diffs, never in the hot path
```

Repo layout (fits your `@nemesis-oss` family; Node 24 LTS, ESM, `ws` + `undici` at the edges only):

```
packages/
  core/        src/{types,ticks,book,features,rules,risk,hash}.ts   # zero deps, pure
  ingest/      src/{shard,recorder,rest}.ts
  exec/        src/{client,orders}.ts
  replay/      src/{replay,backtest}.ts
  app/         src/{actor,main}.ts
registry/      streams.json                                       # corrected /public /market routes
config/        packs/{scalp,intraday,swing}.json
data/          YYYY-MM-DD/HH/<SYMBOL>.jsonl + manifest.jsonl
```

---

## 3. The core, in TypeScript

### 3.1 Exact integer grid — `core/ticks.ts`

```ts
const S = 1e8; // fixed 8-decimal scale; all grid math is integer math

export function scaled(dec: string): number {
  const neg = dec[0] === "-";
  const [i, f = ""] = (neg ? dec.slice(1) : dec).split(".");
  if (f.length > 8) throw new Error(`precision loss: ${dec}`);
  const n = Number(i + f.padEnd(8, "0")); // exact: integer < 2^53
  if (!Number.isSafeInteger(n)) throw new Error(`range: ${dec}`);
  return neg ? -n : n;
}

export interface SymbolSpec {
  symbol: string;
  tick: number;        // tickSize in 1e-8 units, from PRICE_FILTER
  step: number;        // stepSize in 1e-8 units, from LOT_SIZE
  minNotional: number; // NOTIONAL filter, 1e-8 units
}

export const px = (s: SymbolSpec, d: string): number => {
  const v = scaled(d);
  if (v % s.tick !== 0) throw new Error(`off-grid price ${d}`);
  return v / s.tick;                       // integer ticks
};
export const qt = (s: SymbolSpec, d: string): number => {
  const v = scaled(d);
  if (v % s.step !== 0) throw new Error(`off-grid qty ${d}`);
  return v / s.step;                       // integer lots
};
export const fmt = (scaledVal: number): string => { // exact decimal string for orders
  const a = Math.abs(scaledVal), i = Math.floor(a / S);
  const f = (a % S).toString().padStart(8, "0").replace(/0+$/, "");
  return (scaledVal < 0 ? "-" : "") + i + (f ? "." + f : "");
};
export const fmtPx = (s: SymbolSpec, ticks: number) => fmt(ticks * s.tick);
export const fmtQt = (s: SymbolSpec, lots: number) => fmt(lots * s.step);
```

### 3.2 The order book — `core/book.ts` (the correctness-critical piece)

Implements both verified rule sets: the futures `pu` chain  and the spot `U == prev u + 1` chain . The book never performs I/O; the actor feeds it recorded snapshots, which is what makes replay identical.

```ts
import { SymbolSpec, px, qt } from "./ticks.js";

export type Product = "usdm" | "spot";
export interface DepthDiff { e: "depthUpdate"; E: number; T?: number; s: string;
  U: number; u: number; pu?: number; b: [string, string][]; a: [string, string][]; }
export interface DepthSnapshot { lastUpdateId: number; bids: [string, string][]; asks: [string, string][]; }
export type Verdict = "applied" | "stale" | "gap" | "buffered";

class Side {
  prices: number[] = [];                 // sorted: bids desc, asks asc (ticks)
  qty = new Map<number, number>();       // ticks -> lots
  constructor(private desc: boolean) {}
  private idx(p: number): number {       // binary search insertion point
    let lo = 0, hi = this.prices.length;
    while (lo < hi) { const m = (lo + hi) >> 1;
      if (this.desc ? this.prices[m] > p : this.prices[m] < p) lo = m + 1; else hi = m; }
    return lo;
  }
  set(p: number, q: number): void {
    const i = this.idx(p), exists = this.prices[i] === p;
    if (q === 0) { if (exists) { this.prices.splice(i, 1); this.qty.delete(p); } return; } // removal of absent level is normal
    if (!exists) this.prices.splice(i, 0, p);
    this.qty.set(p, q);                  // absolute quantity, per docs
  }
  clear() { this.prices.length = 0; this.qty.clear(); }
  best(): number | undefined { return this.prices[0]; }
  top(k: number): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < Math.min(k, this.prices.length); i++)
      out.push([this.prices[i], this.qty.get(this.prices[i])!]);
    return out;
  }
}

export class Book {
  readonly bids = new Side(true); readonly asks = new Side(false);
  lastU = 0; synced = false; resyncs = 0; crossed = 0;
  private buf: DepthDiff[] = [];
  constructor(private spec: SymbolSpec, private product: Product) {}

  onDiff(ev: DepthDiff): Verdict {
    if (!this.synced) {
      this.buf.push(ev);
      if (this.buf.length > 4096) this.buf.splice(0, this.buf.length - 4096);
      return "buffered";
    }
    if (this.product === "usdm") {
      if (ev.u < this.lastU) return "stale";
      if (ev.pu !== this.lastU) { this.invalidate(); return "gap"; }   // pu chain broken -> re-snapshot
    } else {
      if (ev.u <= this.lastU) return "stale";
      if (ev.U > this.lastU + 1) { this.invalidate(); return "gap"; }  // spot continuity
    }
    this.apply(ev);
    return "applied";
  }

  /** Feed a recorded REST snapshot. false => snapshot unusable, actor must re-fetch. */
  onSnapshot(s: DepthSnapshot): boolean {
    if (this.synced) return true;
    if (this.product === "spot") {
      if (this.buf[0] && s.lastUpdateId < this.buf[0].U) return false;      // snapshot older than first buffered U
      this.buf = this.buf.filter(e => e.u > s.lastUpdateId);                // drop u <= lastUpdateId
      const h = this.buf[0];
      if (!h || !(h.U <= s.lastUpdateId + 1 && h.u >= s.lastUpdateId + 1)) return false;
    } else {
      this.buf = this.buf.filter(e => e.u >= s.lastUpdateId);               // drop u < lastUpdateId
      const h = this.buf[0];
      if (!h || !(h.U <= s.lastUpdateId && h.u >= s.lastUpdateId)) return false; // first event must straddle
    }
    this.load(s);
    for (const e of this.buf) this.apply(e);
    this.buf.length = 0;
    this.synced = true;
    return true;
  }

  invalidate(): void { this.synced = false; this.resyncs++; this.bids.clear(); this.asks.clear(); }

  private load(s: DepthSnapshot): void {
    this.bids.clear(); this.asks.clear();
    for (const [p, q] of s.bids) this.bids.set(px(this.spec, p), qt(this.spec, q));
    for (const [p, q] of s.asks) this.asks.set(px(this.spec, p), qt(this.spec, q));
    this.lastU = s.lastUpdateId;
  }
  private apply(ev: DepthDiff): void {
    for (const [p, q] of ev.b) this.bids.set(px(this.spec, p), qt(this.spec, q));
    for (const [p, q] of ev.a) this.asks.set(px(this.spec, p), qt(this.spec, q));
    this.lastU = ev.u;
    const bb = this.bids.best(), ba = this.asks.best();
    if (bb !== undefined && ba !== undefined && bb >= ba) { this.crossed++; this.invalidate(); } // invariant guard
  }
}
```

### 3.3 Ingest edge — `ingest/shard.ts` and `ingest/recorder.ts`

Registry-driven, split by route as Binance recommends . The `ws` library answers server pings with a payload-copy pong automatically, satisfying both products' keepalive rules .

```ts
// registry/streams.json (excerpt — corrected routes)
// { "usdm": { "public": "wss://fstream.binance.com/public/stream",
//             "market": "wss://fstream.binance.com/market/stream",
//             "perSymbol": { "public": ["@depth@100ms","@bookTicker"],
//                            "market": ["@aggTrade","@markPrice@1s","@kline_1m","@forceOrder"] } } }

import WebSocket from "ws";

export interface ShardOpts { url: string; streams: string[]; onFrame: (stream: string, data: any, recvNs: number) => void; }

export class Shard {
  private ws?: WebSocket; private attempt = 0; private openedAt = 0; private lastMsg = 0; private dead = false;
  constructor(private o: ShardOpts) {}
  start(): void { this.connect(); }
  private connect(): void {
    const url = `${this.o.url}?streams=${this.o.streams.join("/")}`; // one combined connection, <=1024 streams
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => { this.attempt = 0; this.openedAt = Date.now(); this.lastMsg = Date.now(); });
    ws.on("message", (raw) => {
      this.lastMsg = Date.now();
      const msg = JSON.parse(raw.toString());
      if (msg.stream && msg.data) this.o.onFrame(msg.stream, msg.data, recvNs());
      // raw-stream mode / control acks handled here as needed
    });
    const recycle = () => { if (!this.dead) { ws.close(); } };
    ws.on("close", () => { if (this.dead) return;
      const backoff = Math.min(30_000, 500 * 2 ** this.attempt++); // network jitter is outside the pure core;
      setTimeout(() => this.connect(), backoff);                  // the log captures whatever actually arrived
    });
    ws.on("error", () => ws.close());
    setTimeout(recycle, 23 * 3600_000);                            // proactive recycle before the 24h cutoff
  }
  watchdog(): void {                                               // call every 5s from the edge
    if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMsg > 30_000) this.ws.close();
  }
  stop(): void { this.dead = true; this.ws?.close(); }
}

const anchorWall = Date.now(), anchorMono = performance.now();
export const recvNs = (): number => Math.round((anchorWall + (performance.now() - anchorMono)) * 1e6); // metadata only
```

```ts
// recorder.ts — one merged, totally-ordered log per symbol (WS + snapshots + health + fills + meta)
import { createWriteStream, WriteStream } from "node:fs";
import { createHash } from "node:crypto";

export type LogEvent =
  | { seq: number; recvNs: number; kind: "ws"; stream: string; data: any }
  | { seq: number; recvNs: number; kind: "snapshot"; data: any }
  | { seq: number; recvNs: number; kind: "health"; data: { lagMs: number; queue: number; resyncs: number } }
  | { seq: number; recvNs: number; kind: "fill"; data: any }
  | { seq: number; recvNs: number; kind: "meta"; data: any };

export class Recorder {
  private seq = 0; private out!: WriteStream; private hour = -1; private hash = createHash("sha256"); private file = "";
  constructor(private dir: string, private symbol: string) {}
  append(kind: LogEvent["kind"], data: any, stream?: string): LogEvent {
    const now = new Date(); const h = now.getUTCHours();
    if (h !== this.hour) this.rotate(now);
    const ev = { seq: this.seq++, recvNs: recvNs(), kind, ...(stream ? { stream } : {}), data } as LogEvent;
    const line = JSON.stringify(ev) + "\n";
    this.out.write(line); this.hash.update(line);
    return ev;
  }
  private rotate(now: Date): void {
    if (this.out) { this.out.end(); appendManifest(this.dir, { file: this.file, sha256: this.hash.digest("hex"), count: this.seq }); }
    this.hour = now.getUTCHours();
    this.file = `${this.dir}/${now.toISOString().slice(0, 10)}/${String(this.hour).padStart(2, "0")}/${this.symbol}.jsonl`;
    this.out = createWriteStream(this.file, { flags: "a", highWaterMark: 1 << 20 });
    this.hash = createHash("sha256");
  }
}
declare function appendManifest(dir: string, m: object): void; // implement: append JSONL manifest row
import { recvNs } from "./shard.js";
```

### 3.4 Feature fold — `core/features.ts`

Pure `(state, event, book) → state`, emitting a frame whenever the **event-time** 100 ms bucket rolls. This is where your marketplace chapters become formulas. Cancel-vs-fill attribution is a labeled heuristic (aggTrade aggregation and `E`/`T` skew make it approximate), but it is deterministic given the log.

```ts
import { Book } from "./book.js";
import { LogEvent } from "../ingest/recorder.js";
import { SymbolSpec } from "./ticks.js";

export interface Frame { t: number; symbol: string; v: Record<string, number>; }
const K = 10, BPS_WINDOW = 25, RING = 600; // 600 x 100ms = 60s of history

export class Features {
  private bucket = -1; private cvd = 0; private cvdRing = new Float64Array(RING); private ri = 0;
  private spreadRing = new Float64Array(RING); private midPrev = 0; private rvSum = 0;
  private trades: { T: number; p: number; q: number; buy: boolean }[] = [];
  private tradedAt = new Map<number, { lots: number; T: number }>(); // per-price fill attribution tape
  private fills = 0; private cancels = 0; private buyVol = 0; private sellVol = 0; private nTrades = 0;
  private bestBidStableSince = 0; private absorbedLots = 0;
  lagMs = 0; queue = 0;

  constructor(private spec: SymbolSpec) {}

  step(ev: LogEvent, book: Book): Frame | null {
    const d: any = ev.data;
    if (ev.kind === "health") { this.lagMs = d.lagMs; this.queue = d.queue; return null; }
    if (ev.kind !== "ws") return null;
    const E: number = d.E ?? d.T ?? 0;

    if (d.e === "aggTrade") {
      const p = d.p as string, q = d.q as string;
      const pt = Number(p) /* grid conversion via px() in production */, lots = Number(q);
      const buy = d.m === false;                       // m: buyer is maker; false => taker buy
      this.cvd += buy ? lots : -lots;
      this.buyVol += buy ? lots : 0; this.sellVol += buy ? 0 : lots; this.nTrades++;
      this.trades.push({ T: d.T, p: pt, q: lots, buy });
      const cur = this.tradedAt.get(pt) ?? { lots: 0, T: d.T };
      this.tradedAt.set(pt, { lots: cur.lots + lots, T: d.T });
    }

    if (d.e === "depthUpdate" && book.synced) {
      // cancel-vs-fill attribution on level decreases (heuristic, deterministic)
      for (const side of [d.b, d.a] as [string, string][][]) for (const [ps, qs] of side) {
        const p = Number(ps), q = Number(qs);
        const prev = (side === d.b ? book.bids : book.asks).qty.get(p) ?? 0;
        const drop = prev - q;
        if (drop > 0) {
          const t = this.tradedAt.get(p);
          const avail = t && d.E - t.T <= 1000 ? t.lots : 0;
          const fill = Math.min(drop, avail);
          this.fills += fill; this.cancels += drop - fill;
          if (t) t.lots -= fill;
        }
      }
      const bb = book.bids.best();
      if (bb !== undefined) {
        if (bb !== this.bestBidStableSince) { this.bestBidStableSince = bb; this.absorbedLots = 0; }
        else this.absorbedLots += this.sellVol; // sell pressure hitting a stable best bid
      }
    }

    const b = Math.floor(E / 100);
    if (b <= this.bucket) return null;                 // event-time bucket roll drives emission
    this.bucket = b;
    return this.emit(E, book);
  }

  private emit(E: number, book: Book): Frame {
    const bids = book.bids.top(K), asks = book.asks.top(K);
    const bb = bids[0]?.[0] ?? 0, ba = asks[0]?.[0] ?? 0, bq = bids[0]?.[1] ?? 0, aq = asks[0]?.[1] ?? 0;
    const mid = (bb + ba) / 2, spreadBps = mid > 0 ? ((ba - bb) / mid) * 1e4 : 0;
    const micro = bq + aq > 0 ? (ba * bq + bb * aq) / (bq + aq) : mid;
    const sb = bids.reduce((s, [, q]) => s + q, 0), sa = asks.reduce((s, [, q]) => s + q, 0);
    const imb = sb + sa > 0 ? (sb - sa) / (sb + sa) : 0;
    const lo = mid * (1 - BPS_WINDOW / 1e4), hi = mid * (1 + BPS_WINDOW / 1e4);
    const depthB = bids.filter(([p]) => p >= lo).reduce((s, [, q]) => s + q, 0);
    const depthA = asks.filter(([p]) => p <= hi).reduce((s, [, q]) => s + q, 0);
    if (this.midPrev > 0 && mid > 0) { const r = Math.log(mid / this.midPrev); this.rvSum += r * r; }
    this.midPrev = mid;
    this.spreadRing[this.ri % RING] = spreadBps; this.cvdRing[this.ri % RING] = this.cvd; this.ri++;
    const cvd5s = this.cvd - this.cvdRing[Math.max(0, this.ri - 50) % RING];
    const cutoff = E - 5000;
    this.trades = this.trades.filter(t => t.T >= cutoff);
    const v: Record<string, number> = {
      mid, spreadBps, microDevBps: mid > 0 ? ((micro - mid) / mid) * 1e4 : 0,
      imb10: imb, depthBid25: depthB, depthAsk25: depthA,
      cvd: this.cvd, cvdDelta5s: cvd5s,
      takerBuyRatio: this.buyVol + this.sellVol > 0 ? this.buyVol / (this.buyVol + this.sellVol) : 0.5,
      cancelRatio: this.fills + this.cancels > 0 ? this.cancels / (this.fills + this.cancels) : 0,
      absorption: this.absorbedLots, tradeRate5s: this.trades.length / 5,
      rv1m: Math.sqrt(this.rvSum), bookSynced: book.synced ? 1 : 0, resyncs: book.resyncs,
      lagMs: this.lagMs, queue: this.queue,
    };
    this.buyVol = this.sellVol = this.fills = this.cancels = this.nTrades = 0; this.rvSum = 0;
    return { t: E, symbol: this.spec.symbol, v };
  }
}
```

(In production, route the `Number(p)` conversions through `px()/qt()` from §3.1 so attribution stays on the integer grid; I left them explicit here for readability.)

### 3.5 Deterministic rule engine — `core/rules.ts`

Rules are **data**, not code: a predicate AST (no `eval`), fixed evaluation order, hysteresis, event-time cooldowns, and a decision record for every evaluation outcome.

```ts
export type Pred =
  | { feature: string; op: "<" | "<=" | ">" | ">=" | "==" | "!="; value: number }
  | { all: Pred[] } | { any: Pred[] } | { not: Pred };

export interface Rule {
  id: string; priority: number;
  when: Pred;                 // entry condition
  exit: Pred;                 // exit condition (hysteresis: different thresholds)
  cooldownMs: number;
  intent: { side: "BUY" | "SELL"; kind: "LIMIT_MAKER" | "IOC_TAKER"; notionalBps: number; ttlMs: number };
}
export interface RulePack { id: string; gates: Pred[]; rules: Rule[]; }
export interface Intent { ruleId: string; side: "BUY" | "SELL"; kind: string; notionalBps: number; ttlMs: number; t: number; }
export interface Decision { t: number; ruleId: string; outcome: "fire" | "exit" | "gate-reject" | "cooldown" | "no-signal"; frameT: number; }

const evalPred = (p: Pred, v: Record<string, number>): boolean => {
  if ("all" in p) return p.all.every(x => evalPred(x, v));
  if ("any" in p) return p.any.some(x => evalPred(x, v));
  if ("not" in p) return !evalPred(p.not, v);
  const x = v[p.feature] ?? NaN;
  switch (p.op) { case "<": return x < p.value; case "<=": return x <= p.value;
    case ">": return x > p.value; case ">=": return x >= p.value;
    case "==": return x === p.value; case "!=": return x !== p.value; }
};

export class RuleEngine {
  private active = new Map<string, number>();   // ruleId -> entry event-time
  private lastFire = new Map<string, number>();
  private rules: Rule[];
  constructor(private pack: RulePack) {
    this.rules = [...pack.rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)); // total order
  }
  onFrame(f: { t: number; v: Record<string, number> }): { intents: Intent[]; decisions: Decision[] } {
    const intents: Intent[] = [], decisions: Decision[] = [];
    const gatesOk = this.pack.gates.every(g => evalPred(g, f.v));
    for (const r of this.rules) {
      const isActive = this.active.has(r.id);
      if (isActive && evalPred(r.exit, f.v)) {
        this.active.delete(r.id);
        intents.push({ ruleId: r.id, side: r.intent.side === "BUY" ? "SELL" : "BUY", kind: "IOC_TAKER", notionalBps: 0, ttlMs: r.intent.ttlMs, t: f.t });
        decisions.push({ t: f.t, ruleId: r.id, outcome: "exit", frameT: f.t });
        continue;
      }
      if (!gatesOk) { decisions.push({ t: f.t, ruleId: r.id, outcome: "gate-reject", frameT: f.t }); continue; }
      if (isActive) continue;
      const last = this.lastFire.get(r.id) ?? -Infinity;
      if (f.t - last < r.cooldownMs) { decisions.push({ t: f.t, ruleId: r.id, outcome: "cooldown", frameT: f.t }); continue; }
      if (evalPred(r.when, f.v)) {
        this.active.set(r.id, f.t); this.lastFire.set(r.id, f.t);
        intents.push({ ruleId: r.id, ...r.intent, t: f.t });
        decisions.push({ t: f.t, ruleId: r.id, outcome: "fire", frameT: f.t });
      } else decisions.push({ t: f.t, ruleId: r.id, outcome: "no-signal", frameT: f.t });
    }
    return { intents, decisions };
  }
}
```

### 3.6 Three tiers, one engine — `config/packs/*.json`

**Scalp ("HFT" tier, 100 ms frames)** — absorption fade, with regime and health gates:

```json
{
  "id": "scalp-v1",
  "gates": [
    { "feature": "bookSynced", "op": "==", "value": 1 },
    { "feature": "lagMs", "op": "<", "value": 250 },
    { "feature": "spreadBps", "op": "<", "value": 3 },
    { "feature": "tradeRate5s", "op": ">", "value": 5 }
  ],
  "rules": [{
    "id": "absorb-fade-long", "priority": 10,
    "when": { "all": [
      { "feature": "cvdDelta5s", "op": "<", "value": 0 },
      { "feature": "absorption", "op": ">", "value": 50 },
      { "feature": "imb10", "op": ">", "value": 0.15 },
      { "feature": "microDevBps", "op": ">", "value": 0.5 }
    ]},
    "exit": { "any": [
      { "feature": "microDevBps", "op": "<", "value": -0.5 },
      { "feature": "cancelRatio", "op": ">", "value": 0.8 }
    ]},
    "cooldownMs": 3000,
    "intent": { "side": "BUY", "kind": "LIMIT_MAKER", "notionalBps": 25, "ttlMs": 1500 }
  }]
}
```

**Intraday (1 s aggregation of the same frames):** continuation — `imb10` and `cvdDelta5s` aligned, `depthAsk25` thin relative to `depthBid25`, spread tight; exits on imbalance flip; cooldown 30–60 s.

**Swing (1 m/4 h context):** the microstructure features become *execution timing and context*, not the thesis. Add slow inputs folded from logged REST polls and `/market` streams: funding (`@markPrice@1s` carries `r`), open interest (`GET /futures/data/openInterestHist`), kline trend. Rule example: enter long when 4 h trend up + funding negative + OI rising, then use the scalp-tier imbalance gate to time the entry order. Alpha half-life discipline: never let a 100 ms feature open a swing position by itself.

### 3.7 Risk — `core/risk.ts`

```ts
import { Intent } from "./rules.js";
export interface Portfolio { posLots: number; avgPx: number; realizedDay: number; openOrders: number; orders10s: number[]; }
export interface Limits { maxNotionalBps: number; maxOpenOrders: number; dailyLossBps: number; maxOrders10s: number; }

export function riskCheck(i: Intent, v: Record<string, number>, p: Portfolio, l: Limits, equity: number):
  { ok: true; notional: number } | { ok: false; reason: string } {
  if (v.bookSynced !== 1) return { ok: false, reason: "BOOK_UNSYNCED" };
  if (v.lagMs > 250) return { ok: false, reason: "STALE_FEED" };
  if (v.resyncs > 10) return { ok: false, reason: "RESYNC_STORM" };
  if (p.realizedDay < -equity * l.dailyLossBps / 1e4) return { ok: false, reason: "DAILY_LOSS_KILL" };
  if (p.openOrders >= l.maxOpenOrders) return { ok: false, reason: "OPEN_ORDER_CAP" };
  const now = i.t;
  if (p.orders10s.filter(t => now - t < 10_000).length >= l.maxOrders10s) return { ok: false, reason: "ORDER_RATE" };
  const notional = i.notionalBps === 0 ? 0 : equity * i.notionalBps / 1e4; // 0 => flatten
  if (Math.abs(p.posLots * p.avgPx) + notional > equity * l.maxNotionalBps / 1e4) return { ok: false, reason: "POSITION_CAP" };
  return { ok: true, notional };
}
```

Seed `maxOrders10s` from `exchangeInfo.rateLimits` at boot (the documented futures shape is `ORDERS 300/10s` and `1200/min`, shared between REST and the WebSocket API) rather than hardcoding . The portfolio itself is a fold over logged `ORDER_TRADE_UPDATE` fills from `/private`, so replay reproduces it exactly.

### 3.8 Execution edge — `exec/client.ts` (Ed25519, testnet first)

```ts
import { createPrivateKey, sign, createHash } from "node:crypto";
import { Agent, request } from "undici";
import { fmtPx, fmtQt, SymbolSpec } from "../core/ticks.js";

const pool = new Agent({ keepAliveTimeout: 30_000, pipelining: 1 }); // persistent TLS = lower per-order latency

export class Exec {
  private key = createPrivateKey(process.env.BINANCE_ED25519_PEM!);
  private base = process.env.TESTNET === "1" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
  constructor(private apiKey: string, private timeOffsetMs: number) {} // offset from GET /fapi/v1/time at boot

  async place(spec: SymbolSpec, o: { side: "BUY" | "SELL"; type: string; priceTicks?: number; lots: number;
                                     ttlMs?: number; reduceOnly?: boolean; decisionId: string; configHash: string }) {
    const params: Record<string, string> = {
      symbol: spec.symbol, side: o.side, type: o.type,
      quantity: fmtQt(spec, o.lots),
      ...(o.priceTicks !== undefined ? { price: fmtPx(spec, o.priceTicks), timeInForce: "GTX" } : {}),
      ...(o.reduceOnly ? { reduceOnly: "true" } : {}),
      newClientOrderId: "nm" + createHash("sha256").update(o.configHash + "|" + o.decisionId).digest("hex").slice(0, 30),
      timestamp: String(Date.now() + this.timeOffsetMs), recvWindow: "3000",
    };
    const payload = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&"); // alphabetical, per spec
    params.signature = sign(null, Buffer.from(payload), this.key).toString("base64");
    const res = await request(`${this.base}/fapi/v1/order`, {
      method: "POST", dispatcher: pool,
      headers: { "X-MBX-APIKEY": this.apiKey, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.statusCode, body: await res.body.json() };
  }
}
```

The deterministic `newClientOrderId` gives idempotency across restarts: on boot, query open orders, log the response, and reconcile before resuming. For the scalp tier, move order placement to the persistent WebSocket API (`session.logon` once, then `order.place` per intent) — same signature scheme, decimals as strings, timestamps as JSON integers . Testnet REST is `testnet.binancefuture.com`; testnet streams are `wss://fstream.binancefuture.com` .

### 3.9 The actor and the replay gate — `app/actor.ts`, `replay/replay.ts`

```ts
// actor.ts — the single writer per symbol; the ONLY place the fold is defined
export class SymbolActor {
  book: Book; feat: Features; engine: RuleEngine;
  private snapshotInFlight = false; private lastSnapshotAt = 0;
  constructor(spec: SymbolSpec, pack: RulePack, private rest: Rest, private rec: Recorder, private sink: (f: Frame, d: Decision[]) => void) {
    this.book = new Book(spec, "usdm"); this.feat = new Features(spec); this.engine = new RuleEngine(pack);
  }
  async handle(ev: LogEvent): Promise<void> {
    if (ev.kind === "snapshot") { this.snapshotInFlight = false; this.book.onSnapshot(ev.data); }
    if (ev.kind === "ws" && ev.data?.e === "depthUpdate") {
      const verdict = this.book.onDiff(ev.data);
      if ((verdict === "gap" || verdict === "buffered") && !this.snapshotInFlight
          && ev.recvNs / 1e6 - this.lastSnapshotAt > 1000) {          // weight-budgeted re-snapshot
        this.snapshotInFlight = true; this.lastSnapshotAt = ev.recvNs / 1e6;
        const snap = await this.rest.depth(this.book["spec"].symbol, 1000);
        this.handle(this.rec.append("snapshot", snap));               // snapshot goes THROUGH the log (D1)
      }
    }
    const frame = this.feat.step(ev, this.book);
    if (frame) { const { decisions } = this.engine.onFrame(frame); this.sink(frame, decisions); }
  }
}
```

```ts
// replay.ts — the equality assertion is your best testing tool
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

export async function replay(logFile: string, makeActor: (meta: any) => SymbolActor): Promise<string> {
  const hash = createHash("sha256"); let actor: SymbolActor | null = null;
  for await (const line of createInterface({ input: createReadStream(logFile) })) {
    const ev = JSON.parse(line) as LogEvent;
    if (ev.kind === "meta") { actor = makeActor(ev.data); continue; }   // spec + configHash + packs recorded at boot
    await actor!.handle(ev);                                            // identical fold, zero I/O besides the log
  }
  return hash.digest("hex"); // hash frames/decisions inside sink; compare with the live audit hash
}
```

Wire the live `sink` to append frames/decisions to an audit JSONL and update its hash; CI runs `replay` over a committed fixture and asserts the hashes match. If they diverge, you have a nondeterminism bug — full stop.

---

## 4. Backtesting and fill realism

Run the **same fold** with a simulated executor:

- **Taker/IOC:** walk the reconstructed book at decision time; slippage comes from actual per-level depth, not a fixed assumption.
- **Maker (GTX):** conservative queue model — fill only when subsequent `aggTrade` prints *through* your price, or the level's quantity depletes beyond your size. `aggTrade` cannot reveal queue position, so never assume top-of-queue.
- **Costs:** fees from `GET /fapi/v1/commissionRate` (recorded into the log), funding accrual from `@markPrice` events.
- **History:** Binance Vision gives you trades/aggTrades/klines for warm-up, but full diff-depth history is not downloadable — your recorder is the only source, which is why it ships first. If you need depth history before your own recordings exist, Tardis.dev sells reconstructed Binance futures depth captured at the fastest cadence .

---

## 5. Test matrix and operations

| Layer    | Tests                                                                                                                                                                                               |
|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ticks    | off-grid rejection, round-trip `fmt(px(x)) == x`, 8-decimal edge cases                                                                                                                              |
| book     | documented edge cases: straddling first event, `pu` break → resync, removing an absent level is a no-op ; spot `U > lastU+1` → full restart ; property test (fast-check): synced book never crosses |
| features | golden fixture hashes; bucket emission driven only by event time                                                                                                                                    |
| rules    | evaluation order stable under pack permutation; cooldown/hysteresis unit tests                                                                                                                      |
| chaos    | kill WS mid-stream, inject `pu` gaps, snapshot 429/418 with `Retry-After` backoff                                                                                                                   |
| replay   | live ≡ replay hash gate on every commit                                                                                                                                                             |

Ops checklist: chrony-synced clock; Node 24 LTS pinned; no synchronous logging in the hot path; lag SLO (`E` vs receipt) with symbol shedding above threshold; resync-rate budget per symbol; snapshot weight budgeting against the IP weight pool; staggered 23 h connection recycles; honor the 10-msg/s (futures) / 5-msg/s (spot) control-message caps by batching `SUBSCRIBE` frames ; separate `/public` and `/market` connections exactly as Binance recommends for jitter isolation .

---

## 6. Build order

1. **Days 1–2:** recorder + shards + meta/health logging. Start recording immediately — depth history you do not record today is gone forever.
2. **Days 3–4:** book + sync tests (golden fixtures, gap injection).
3. **Days 5–6:** features + the replay equality gate in CI.
4. **Days 7–8:** rule packs + risk + decision log; explore features on recorded data before writing more rules.
5. **Days 9–10:** backtest executor with depth-walk slippage and conservative maker fills.
6. **Days 11–12:** testnet execution + `/private` fill fold + idempotent restart reconciliation.
7. **Days 13–14:** soak in Tokyo region, then promote with minimal size.

For `nemesis-crypto-agent`, keep the Ollama layer strictly advisory: a nightly job may propose threshold diffs as a versioned config change, but promotion requires the replay gate to pass under the new `configHash`. The LLM never sits in the decision path — that is what preserves determinism while still benefiting from the agentic layer.

Two immediate action items before any of this runs: regenerate the registry's USDⓈ-M rows with the `/public` and `/market` routes (the legacy URLs are already retired), and re-verify the COIN-M rows against its still-unmigrated `dstream` host at integration time .

If you want, I can generate the full npm-workspace scaffold — all packages above wired end-to-end with the corrected `streams.json`, vitest fixtures for both sync rule sets, and the replay CLI — as a repository you can start recording with today.

Short answer: **Binance gives away most of this data in bulk for free — but not the one dataset your deterministic book engine actually depends on.** I verified the current archive listings directly against the `data.binance.vision` S3 bucket today, and the distinction is sharp. The efficient design is therefore a hybrid: backfill everything backfillable from Vision/REST, self-record only the irreducible streams, and store those compressed and columnar. The storage cost, with measured numbers below, is trivial.

---

## 1. What Binance actually provides historically (verified against the live bucket)

The official archive is `data.binance.vision` — free, MIT-licensed, daily/monthly ZIP-CSV files with SHA-256 `.CHECKSUM` sidecars; new daily files appear the next day, monthly files on the first Monday of the month . I enumerated the actual S3 prefixes rather than trusting documentation:

| Product                   | Dataset folders present (live listing)                                                                                             | Granularity / caveat                                                                                                                                                 |
|---------------------------|------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Spot**                  | `aggTrades`, `trades`, `klines` — **nothing else**                                                                                 | No order-book data of any kind; timestamps are **microseconds from 2025-01-01** onward                                                                               |
| **USDⓈ-M (`um/daily`)**   | `aggTrades`, `trades`, `klines`, `markPriceKlines`, `premiumIndexKlines`, `indexPriceKlines`, `bookDepth`, `bookTicker`, `metrics` | `bookTicker` for BTCUSDT **starts 2023-05-16 and ends 2024-03-30** — discontinued, verified from the last key in the listing , corroborated by an independent survey |
| **USDⓈ-M (`um/monthly`)** | adds `fundingRate` (there is **no** `fundingRate` daily prefix)                                                                    | Funding history is monthly-archive or REST                                                                                                                           |
| **COIN-M (`cm/daily`)**   | all of the above **plus `liquidationSnapshot`**                                                                                    | USDⓈ-M has no liquidation archive; COIN-M does                                                                                                                       |
| **Options**               | `BVOLIndex`, `EOHSummary` only                                                                                                     | No options trades/depth archives                                                                                                                                     |

REST historical coverage, for completeness:

- `klines` / `markPriceKlines` / `premiumIndexKlines` / `indexPriceKlines`: full history, paginated — but for bulk, Vision is the correct path .
- `aggTrades` / `trades`: paginated and recent-oriented (`fromId`/`startTime`/`endTime`, ≤1000/page); years of bulk via REST is impractical — use Vision .
- `fundingRate`: full history via `GET /fapi/v1/fundingRate` .
- **`/futures/data/*` (openInterestHist, top/global long-short ratios, taker buy/sell, basis): only the latest 30 days is available**, at 1000 requests/5 min per IP . Beyond 30 days, OI/ratios must come from Vision `metrics` (5-minute granularity) or a vendor .
- **There is no REST endpoint for historical order-book snapshots or diffs.** None.

One operational caveat from the official README: archived files are occasionally **silently corrected and re-uploaded** (there is an updates changelog), so pin the `.CHECKSUM` of every file you ingest into your manifest — otherwise a "deterministic" backfill can change underneath you .

---

## 2. The decisive distinction: `bookDepth` is not your depth stream

This is where most people incorrectly conclude "Binance has the data, I don't need to record."

- **`bookDepth`** is ~2,880 snapshots/day (**30-second cadence**) of *cumulative depth in percentage bands around mid* (±0.2% … ±5%), 10 band-rows per snapshot, 4 columns — verified by convergent evidence: the COIN-M test pull yields exactly 57,600 rows over 2 days , an independent survey describes the same bands/cadence , and the BTCUSDT daily ZIP is only ~526 kB .
- **`metrics`** is 288 rows/day (**5-minute**): open interest, top-trader/global long-short ratios, taker buy/sell volume .

Neither carries per-price levels, nor `U`/`u`/`pu` sequence IDs, nor cancel events. **Snapshots alone cannot reproduce queue evolution** — you cannot compute cancel ratio, absorption, refill rate, 100 ms imbalance dynamics, or depth-walk slippage from them, and you cannot do gap-free deterministic book replay . They are excellent *free swing-context* inputs (liquidity regime, OI/funding trends). They are useless as a substitute for `<symbol>@depth@100ms`.

So the irreducible, non-backfillable-free dataset is exactly one: **sequenced incremental L2 depth** (plus `aggTrade` if you want tick-exact trade/book alignment). Spot has zero book archives; futures `bookTicker` archives are dead for USDⓈ-M; `bookDepth` is banded snapshots. Everything else in your feature set is backfillable.

---

## 3. Is self-recording efficient? Yes — measured numbers

Anchors from actual Vision files (BTCUSDT, measured row counts/sizes) :

| Stream                     | Measured volume                     | Implication                                                   |
|----------------------------|-------------------------------------|---------------------------------------------------------------|
| USDⓈ-M `aggTrades`         | 2.23 M msgs/day (~26/s), 141 MB CSV | ~424 MB/day as raw WS JSONL → **~42 MB/day zstd**             |
| USDⓈ-M `trades`            | 5.29 M/day, 269 MB CSV              | You don't need raw `trade` if you have `aggTrade`             |
| USDⓈ-M `bookTicker` (2023) | 4.49 M/day, 406 MB CSV              | The biggest firehose — and **fully derivable from your book** |
| `metrics` / `fundingRate`  | 44.6 KB / 2 days; 4.7 KB / 2 months | Backfill free; don't record                                   |

Computed storage for the **minimal live set** (`depth@100ms` + `aggTrade` + `markPrice@1s` + `forceOrder`), per symbol per day (depth is the only unanchored estimate; 20–150 level updates/msg):

| Format                   | Per symbol        | 3 symbols            | Per year (3 symbols)          |
|--------------------------|-------------------|----------------------|-------------------------------|
| Raw JSONL                | 1.0–4.0 GB/day    | 3–12 GB/day          | 1.1–4.4 TB                    |
| **JSONL + zstd (8–12×)** | **85–507 MB/day** | **0.26–1.52 GB/day** | **93–555 GB**                 |
| Typed Parquet + zstd     | comparable size   | comparable           | columnar, 10–50× faster scans |

Cost reality check (computed, not hand-waved):

- S3 Standard, year-1 cumulative: **~$14–82** for 3 symbols. Glacier IR: **~$2–14**.
- A local 2 TB NVMe (~$120 one-time) holds **3.6–21 years** of this data.
- The real cost driver is **egress on cold replay** ($0.09/GB beyond 100 GB/mo free → ~$0–41 per full-year pass), which is why you keep a warm local cache.
- Vision backfill itself is free, including download.

**Efficiency rules that make this cheap:**

1. **Drop derivable streams.** `bookTicker` (top-of-book) and `kline_*` (bars) are computable in-fold from the book and `aggTrade`. Dropping them removes the single largest firehose. Caveat tied to your determinism contract D1: *if* a fold consumes them as independent inputs (e.g., bookTicker as a cross-check), they must be logged; otherwise derive them and log nothing.
2. **Never sample the depth stream.** Gaps break `pu` continuity and force resyncs; the diff stream is all-or-nothing.
3. **Tier the storage:**
   - *Hot (7–14 days, NVMe):* append-only JSONL, hourly rotation, zstd-compressed, manifest + sha256. Sequential writes, no random I/O — this is the efficient path.
   - *Warm (90–365 days):* nightly compaction to typed Parquet — one row per level update, integer ticks/lots (your D2 grid):
     ```sql
     -- DuckDB nightly job; preserves total order via seq
     COPY (
       SELECT seq, E, T, U, u, pu, side,
              price_ticks, qty_lots          -- int64, delta/RLE-friendly
       FROM read_json_auto('data/2026-11-21/*/BTCUSDT.jsonl')
       WHERE kind='ws' AND stream LIKE '%@depth%'
       ORDER BY seq
     ) TO 'warm/BTCUSDT-2026-11-21.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
     ```
   - *Cold (audit):* raw zstd archives → S3 Glacier lifecycle.
   - *Forever:* frames + decisions Parquet (tiny — these are your actual research artifacts).
4. **Extend the replay gate:** `replay(raw JSONL) ≡ replay(Parquet)` must produce identical frame hashes. Parquet reads through the same typed `LogEvent` interface ordered by `seq`, so D6 holds across the compaction boundary.
5. **Backfill job** (free, deterministic, checksum-pinned):
   ```
   https://data.binance.vision/data/futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-10.zip
   https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2026-11-20.zip
   + .CHECKSUM (sha256) verified before ingest; record the checksum in your manifest
   ```
   Use monthly archives for complete months and daily only at range edges — 12 requests/year instead of 365 . At boot, this warms every rolling window (CVD anchors, vol, OI/funding context) without recording anything redundant.

---

## 4. If you need book history *before* your recorder exists

There is exactly one practical source for historical sequenced L2 diffs: **Tardis.dev** (paid). Verified specifics that matter for your engine :

- `binance-futures` coverage for all instruments since **2019-11-17**; `incremental_book_L2` recorded at `depth@100ms` until 2020-01-07, then **`depth@0ms` (real-time)** — finer than what you can even subscribe to today on the public JSON feed.
- They store a **generated `depthSnapshot` channel** (REST top-1000 snapshots) *alongside* the WS messages, and validate `pu`/`u` integrity with reconnect-on-gap — which is precisely the D1/D3 design specified in the previous turn, independently validated at production scale.
- Data format is **raw exchange WS payloads + local timestamps**, with a Node.js client (`tardis-dev`) — it maps 1:1 into your `LogEvent` fold, so replay/backtest code is unchanged .
- `forceOrder` (liquidations, latest per symbol per 1000 ms) since 2020-01-07; `openInterest` ~6 s polls since 2020-05-12 — covering the two datasets USDⓈ-M Vision lacks.
- First day of each month is downloadable **without an API key** (free samples for your acceptance tests); published plans start around $350/month .
- They also confirm Binance servers sit in AWS `ap-northeast-1` (Tokyo) and that they migrated capture to `/public` + `/market` on 2026-03-18 — corroborating the registry correction from the previous turn .

Run their sample through your book builder and assert top-of-book reconciliation before paying — snapshots-only vendors cannot pass that gate .

---

## 5. Decision matrix

| Tier / feature class                                                                      | Source                                                                 | Record live?                                    |
|-------------------------------------------------------------------------------------------|------------------------------------------------------------------------|-------------------------------------------------|
| Swing context: klines, funding, mark/premium/index, OI & L/S ratios (>30 d via `metrics`) | Vision bulk + REST — **free, full history**                            | No                                              |
| Intraday: CVD, trade intensity, realized vol                                              | Vision `aggTrades` — free, full history                                | Only for tick-exact alignment with your book    |
| Scalp/book: imbalance dynamics, cancel ratio, absorption, refill, depth-walk slippage     | **Nowhere free** — spot has no book archive; `bookDepth` is 30 s bands | **Yes: `depth@100ms` + `aggTrade`, from day 1** |
| Liquidations (USDⓈ-M)                                                                     | No Vision archive; COIN-M has `liquidationSnapshot`                    | Yes (`@forceOrder`, sparse/cheap) or Tardis     |
| Pre-recorder book history                                                                 | Tardis (paid), raw WS format, Node client                              | Buy once, fold identically                      |

**Bottom line:** storing is efficient *if you store the right subset* — the minimal live set is ~85–507 MB/day/symbol compressed, a few dollars a month in object storage, and years fit on one NVMe drive. Binance's free archive covers your swing and intraday context completely, so record only what it provably does not provide: the sequenced depth stream (and `aggTrade` for alignment). That recorder is not a cost burden — it is the sole source of the one input that makes your deterministic engine reproducible, and every day you delay starting it is a day of book history you can never get back for free.

All three questions are answered below from documentation verified today (spot and futures REST catalogs, the Market-Data-Only FAQ, the live `data.binance.vision` bucket listings checked in the previous turn, and vendor pages). The caching design is wired to the determinism contract (D1–D7) from the earlier architecture, so it optimizes retrieval without breaking replay equivalence.

---

## 1. Specific limitations of Binance public endpoints for historical data

### 1.1 Coverage gaps — the hard walls

| Data                                      | Historical availability via Binance public surfaces                                                                                                                                             |
|-------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Incremental L2 depth (`U/u/pu` diffs)** | **None.** No REST endpoint, no Vision archive. Spot has no book data at all; futures `bookDepth` is ~30-second *banded* snapshots (±0.2%…±5% cumulative depth), not per-price levels            |
| **USDⓈ-M `bookTicker` archive**           | Discontinued — BTCUSDT daily files run 2023-05-16 → **2024-03-30** and stop (verified from the bucket's last key; independently corroborated )                                                  |
| **USDⓈ-M liquidations**                   | No Vision archive (`liquidationSnapshot` exists for COIN-M only, per the live `cm/daily` listing)                                                                                               |
| **USDⓈ-M funding rate archive**           | Monthly only (`um/monthly/fundingRate`); no daily prefix. REST `GET /fapi/v1/fundingRate` remains the full-history source                                                                       |
| **Options**                               | Vision carries only `BVOLIndex` and `EOHSummary` — no trades, no depth                                                                                                                          |
| **RPI liquidity**                         | Standard `depth`/`bookTicker` **exclude** Retail Price Improvement orders; only `GET /fapi/v1/rpiDepth` includes them, and it is snapshot-only (limit fixed at 1000, weight 20) with no history |
| **OI / long-short / taker ratios**        | `GET /futures/data/*` serves **only the latest 30 days**; beyond that, Vision `metrics` at 5-minute granularity is the only free path                                                           |

### 1.2 Retention windows and query constraints

| Endpoint                                                        | Constraint (verified current catalog)                                                                                        |
|-----------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `/api/v3/aggTrades`, `/fapi/v1/aggTrades`, `/dapi/v1/aggTrades` | If both `startTime` and `endTime` are sent, the window **must be < 1 hour**; `fromId` pagination otherwise; max `limit` 1000 |
| `/api/v3/trades`, `/fapi/v1/trades`                             | **Recent only** — no `fromId`/time-range parameters; max 1000                                                                |
| `/api/v3/historicalTrades`                                      | `fromId`-only pagination, max 1000; **no time-range query**                                                                  |
| `/fapi/v1/historicalTrades`                                     | API key required (`MARKET_DATA`), weight 20, `fromId` pagination                                                             |
| `/futures/data/openInterestHist` etc.                           | 30-day retention; `period` ≥ 5m; max `limit` 500                                                                             |
| Klines (spot/futures)                                           | Full history, but the **current open bar is mutable** — never treat it as final; futures max `limit` 1500, spot 1000         |

### 1.3 Pagination, weight, and ban mechanics

Current weights (these differ from values many SDKs still hardcode — budget drift is a real failure mode):

| Endpoint                           | Weight                                                                       | Max limit |
|------------------------------------|------------------------------------------------------------------------------|-----------|
| Spot `aggTrades`                   | **4**                                                                        | 1000      |
| Spot `trades` / `historicalTrades` | **25** each                                                                  | 1000      |
| Spot `klines` / `uiKlines`         | 2                                                                            | 1000      |
| Spot `depth`                       | **5 / 25 / 50 / 250** by limit tier (1–100 / 101–500 / 501–1000 / 1001–5000) | 5000      |
| Futures `aggTrades`                | **20**                                                                       | 1000      |
| Futures `trades`                   | 5                                                                            | 1000      |
| Futures `klines`                   | **1 / 2 / 5 / 10** by LIMIT tier                                             | 1500      |
| Futures `depth`                    | scales with limit; heaviest at 1000 (weight 20, same tier as `rpiDepth`)     | 1000      |
| `/futures/data/*` ratios | **weight 0**, but request-count-limited per IP (openInterestHist 1000/5min; top-trader ratios share **500/5min/IP** and are now documented as `MARKET_DATA` requiring `X-MBX-APIKEY`)  |

IP weight pools are separate per product (futures `REQUEST_WEIGHT` 2400/min, confirmed in the WS-API rate-limit response shape; spot has its own pool — read both from `exchangeInfo.rateLimits` at boot rather than hardcoding). Exceeding a pool returns 429 with `Retry-After`; repeated violations escalate to 418 IP bans .

**Worked example (computed):** backfilling one year of BTCUSDT USDⓈ-M `aggTrades` via REST ≈ 815M rows → **814,629 pages × weight 20 = 16.3M weight ≈ 4.7 days of saturated polling** at the 2400/min futures pool — and the <1-hour window rule forces ≥8,760 time-window queries before pagination even begins. The Vision equivalent is **12 monthly ZIPs, free** (~1.7 GB CSV at the measured 141 MB/day) . One year of 1m klines is only 351 pages × weight 10 ≈ 1.5 minutes of pool — cheap via REST, but Vision still wins on integrity and simplicity.

### 1.4 Granularity ceilings

- `aggTrade` aggregates fills per taker order — on futures you cannot recover individual fill prints from it; raw `trade` history is not REST-accessible beyond the recent window .
- **No market-by-order (L3/MBO) data anywhere** — no order IDs, no queue position. Maker-fill modeling must stay conservative.
- Depth JSON cadence floor: futures 250 ms default / 100 ms fastest; spot 1000 ms / 100 ms. (Spot SBE reaches 20 ms diffs but requires an Ed25519 key header — not anonymous, and live-only.)
- OI history minimum period 5m; `markPrice` stream 1s; spot klines down to 1s, futures klines from 1m.
- Rolling-window tickers (`/api/v3/ticker`) can be **up to 59,999 ms longer** than the requested `windowSize` — do not treat them as exact windows .

### 1.5 Publication, integrity, and access caveats

- Vision daily files appear **T+1**; monthly on the **first Monday**; ZIP-CSV with `.CHECKSUM` (SHA-256); MIT-licensed .
- Archives are **silently corrected and re-uploaded** (the README maintains an updates changelog) — pin every checksum in your manifest or your "immutable" backfill can change underneath you .
- **Timestamp unit discontinuity:** spot Vision data is microseconds from 2025-01-01 onward, milliseconds before — normalize explicitly at ingest .
- `data-api.binance.vision` serves a **fixed 13-endpoint subset** (aggTrades, avgPrice, depth, exchangeInfo, klines, ping, ticker family, time, trades, uiKlines) — **`historicalTrades` is not included**; its WS counterpart `data-stream.binance.vision` is market-data-only, no user streams .
- Security classification has shifted: the current global spot catalog lists `historicalTrades` without a `MARKET_DATA` header requirement (weight 25), consistent with the documented `MARKET_DATA → NONE` transition ; conversely, futures `historicalTrades` and the top-trader long/short ratios now **require** an API key . Re-verify classifications at integration time rather than trusting older catalogs.
- No SLA on public data; collection gaps/incidents exist (vendors document them); delisted symbols survive only in Vision, not `exchangeInfo`.

---

## 2. A local caching strategy that fits the deterministic engine

The core principle: **cache by mutability class, not by a single TTL.** A depth snapshot and a settled funding rate have nothing in common; treating them alike either corrupts your book or wastes weight.

### 2.1 Mutability classes

| Class              | Examples                                                                                                     | Key                                  | Invalidation                                                                      | Store                   |
|--------------------|--------------------------------------------------------------------------------------------------------------|--------------------------------------|-----------------------------------------------------------------------------------|-------------------------|
| **Immutable**      | Vision monthly/daily ZIPs for closed periods, closed kline bars, settled funding, finalized aggTrades ranges | `(dataset, symbol, period)` + sha256 | Never; revalidate only against Vision's revision changelog                        | Parquet lake + manifest |
| **Recent-mutable** | Today's Vision file, last N kline bars, aggTrades tail                                                       | `(endpoint, params)`                 | Short TTL (1 s–5 min) + ETag/CHECKSUM revalidation                                | Disk (DuckDB index)     |
| **Live**           | `exchangeInfo`, `premiumIndex`, `openInterest`, time offset                                                  | `(endpoint, params)`                 | Seconds–minutes; `exchangeInfo` also invalidated by `!contractInfo` stream events | In-memory LRU + disk    |
| **Never cache**    | Book-bootstrap depth snapshot, open kline bar as final, order/account state                                  | —                                    | Always fresh; per-symbol rate limit + single-flight instead                       | —                       |

The depth-snapshot rule is non-negotiable: a cached snapshot is unusable for bridging if it violates the freshness condition (spot: `lastUpdateId ≥ U` of first buffered event; futures: the straddle rule). Cache snapshots only for *research* warm-up, explicitly labeled stale — never for book sync.

### 2.2 Layers

```
L0  in-process LRU (exchangeInfo, symbol specs)         ~µs
L1  single-flight coalescing (dedupe identical in-flight requests across workers)
L2  weight-aware scheduler (token bucket per IP pool, seeded from exchangeInfo.rateLimits;
    reconcile X-MBX-USED-WEIGHT headers; 429 Retry-After pause; 418 ban backoff)
L3  disk cache: DuckDB manifest index + content-addressed Parquet/ZIP lake (sha256, atomic tmp→rename)
L4  origin: Vision S3 (conditional GET, If-None-Match/ETag) → Binance REST (keep-alive undici Agent)
```

### 2.3 Per-data-type policies

- **Vision backfill:** monthly archives for complete months, daily only at range edges (12 requests/year, not 365); conditional GET with stored ETag; verify `.CHECKSUM` before promotion to immutable; pin the checksum in the manifest .
- **Klines:** closed bars → immutable Parquet; fetch only the open bar + last few bars live; revalidate the last N closed bars against Vision checksums periodically (revision protection).
- **aggTrades:** historical from Vision (immutable); live tail via REST recent-window (no time params, cheapest) with ~1 s TTL for CVD warm-up.
- **exchangeInfo:** TTL 1 h **plus** event-driven invalidation on `!contractInfo` (futures) — log the invalidation.
- **Negative cache:** unknown symbol (−1121) / geo-restriction (451) → 1 h TTL, so a bad config cannot hammer the pool.
- **Stampede protection:** single-flight + jittered TTL. Jitter is edge-only randomness; it never enters the fold (D4).

### 2.4 Implementation (TypeScript, edge-only)

```ts
// ingest/cache.ts — NEVER imported by core folds (D7)
import { Agent, request } from "undici";
import { createHash } from "node:crypto";
import { rename, writeFile, readFile } from "node:fs/promises";

type Cls = "immutable" | "recent" | "live" | "never";
interface Policy { cls: Cls; ttlMs: number; weight: number; }

const POLICY: Record<string, Policy> = {
  "vision":                  { cls: "immutable", ttlMs: Infinity,   weight: 0 },
  "/fapi/v1/klines":         { cls: "recent",    ttlMs: 60_000,     weight: 10 },
  "/fapi/v1/aggTrades":      { cls: "recent",    ttlMs: 1_000,      weight: 20 },
  "/fapi/v1/exchangeInfo":   { cls: "live",      ttlMs: 3_600_000,  weight: 1 },
  "/fapi/v1/premiumIndex":   { cls: "live",      ttlMs: 3_000,      weight: 1 },
  "/fapi/v1/openInterest":   { cls: "live",      ttlMs: 5_000,      weight: 1 },
  "/fapi/v1/depth":          { cls: "never",     ttlMs: 0,          weight: 20 }, // bootstrap: always fresh
};

class WeightBucket {                       // one per IP pool (spot / futures separate)
  private tokens: number; private pausedUntil = 0;
  constructor(private capacity: number, private refillPerMs: number) { this.tokens = capacity; }
  async take(w: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) { await sleep(this.pausedUntil - now); continue; }
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
      this.last = now;
      if (this.tokens >= w) { this.tokens -= w; return; }
      await sleep((w - this.tokens) / this.refillPerMs);
    }
  }
  pause(ms: number) { this.pausedUntil = Date.now() + ms; }   // 429 Retry-After / 418 backoff
  private last = Date.now();
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class CachedClient {
  private inflight = new Map<string, Promise<any>>();        // L1 single-flight
  private mem = new Map<string, { v: any; exp: number }>();  // L0 LRU (cap + evict in production)
  private pool = new Agent({ keepAliveTimeout: 30_000, pipelining: 1 });
  constructor(private bucket: WeightBucket, private log: (ev: any) => void, private lake: string) {}

  private key(ep: string, p: Record<string, any>) {
    return createHash("sha256").update(ep + "|" + JSON.stringify(p, Object.keys(p).sort())).digest("hex");
  }

  async get(ep: string, params: Record<string, any>, base = "https://fapi.binance.com"): Promise<any> {
    const pol = POLICY[ep] ?? { cls: "live", ttlMs: 5_000, weight: 1 };
    if (pol.cls === "never") return this.origin(ep, params, base, pol);   // depth: bypass cache entirely
    const k = this.key(ep, params);
    const hit = this.mem.get(k);
    if (hit && hit.exp > Date.now()) { this.log({ kind: "cache", key: k, hit: true }); return hit.v; }
    if (this.inflight.has(k)) return this.inflight.get(k)!;               // coalesce concurrent misses
    const p = (async () => {
      const disk = await this.readLake(k);                                // L3 (DuckDB index → path)
      if (disk && (pol.cls === "immutable" || disk.exp > Date.now())) {
        this.mem.set(k, { v: disk.v, exp: disk.exp }); this.log({ kind: "cache", key: k, hit: true }); return disk.v;
      }
      const v = await this.origin(ep, params, base, pol);
      const exp = pol.cls === "immutable" ? Infinity : Date.now() + pol.ttlMs;
      this.mem.set(k, { v, exp }); await this.writeLake(k, v, exp);
      return v;
    })().finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private async origin(ep: string, params: Record<string, any>, base: string, pol: Policy) {
    await this.bucket.take(pol.weight);                                   // L2
    const qs = new URLSearchParams(params as any).toString();
    const res = await request(`${base}${ep}?${qs}`, { dispatcher: this.pool });
    if (res.statusCode === 429) { this.bucket.pause(Number(res.headers["retry-after"] ?? 5) * 1000); throw new Error("429"); }
    if (res.statusCode === 418) { this.bucket.pause(60_000); throw new Error("418 ban"); }
    const used = Number(res.headers["x-mbx-used-weight-1m"] ?? NaN);      // reconcile bucket with server truth
    if (Number.isFinite(used)) this.bucket.reconcile?.(used);
    const v = await res.body.json();
    this.log({ kind: "ws", stream: `rest:${ep}`, data: v });              // D1: payload enters the log
    return v;
  }

  // Vision: conditional GET + checksum pinning + atomic promotion to immutable
  async vision(url: string, expectedSha256?: string): Promise<Buffer> {
    const k = this.key("vision", { url });
    const cached = await this.readLakeRaw(k);
    const res = await request(url, { dispatcher: this.pool,
      headers: cached?.etag ? { "if-none-match": cached.etag } : {} });
    if (res.statusCode === 304) return cached!.buf;
    const buf = Buffer.from(await res.body.arrayBuffer());
    const sha = createHash("sha256").update(buf).digest("hex");
    if (expectedSha256 && sha !== expectedSha256) throw new Error("Vision checksum mismatch");
    await this.writeLakeRaw(k, buf, String(res.headers.etag ?? ""), sha);  // tmp → rename
    return buf;
  }
  // readLake/writeLake/readLakeRaw/writeLakeRaw: DuckDB-indexed, content-addressed file store (below)
  private async readLake(k: string): Promise<{ v: any; exp: number } | null> { /* index lookup */ return null; }
  private async writeLake(k: string, v: any, exp: number): Promise<void> { /* atomic */ }
  private async readLakeRaw(k: string): Promise<{ buf: Buffer; etag: string } | null> { return null; }
  private async writeLakeRaw(k: string, buf: Buffer, etag: string, sha: string): Promise<void> {
    const tmp = `${this.lake}/${k}.tmp`; await writeFile(tmp, buf); await rename(tmp, `${this.lake}/${k}`);
  }
}
```

Manifest index (DuckDB — also your backfill query engine):

```sql
CREATE TABLE cache_index(
  key TEXT PRIMARY KEY, cls TEXT, endpoint TEXT, params JSON,
  sha256 TEXT, etag TEXT, path TEXT, bytes BIGINT,
  fetched_at BIGINT, expires_at BIGINT          -- Infinity => immutable
);
```

**Boot warm-up order:** `exchangeInfo` (specs + rateLimits) → `/fapi/v1/time` offset → Vision backfill (monthly + daily edges, checksum-pinned) → REST tail top-up (open bar, aggTrades last 1000) → live WS. Every cache-served payload that feeds the fold is logged as a `LogEvent` with its sha256 and hit/miss flag; **replay reads the log, never the cache** — so D6 (live ≡ replay) holds regardless of cache state.

### 2.5 Observability

Track hit ratio per class, weight consumed vs pool, origin p95, 429/418 counts, and single-flight coalescing rate. Alert on miss storms (they precede bans). Evict the hot LRU by size cap (e.g., 50 GB NVMe); the immutable Parquet lake grows append-only and is never evicted.

---

## 3. Third-party APIs for more efficient or granular Binance data

The decisive question is not "who has Binance data" but **"who has replayable incremental L2 diffs versus snapshots only."** An independent vendor comparison lists exactly six providers offering incremental L2 capable of rebuilding the book: Tardis.dev, Amberdata, CoinAPI, Kaiko, Crypto Lake, and CoinDesk Data . Their granularity differs sharply:

| Vendor            | Binance L2 offering                                                                                                   | Granularity                                                                                  | Access / format                                                                                                    | Free tier                                                | Fit for your engine                                                                                               |
|-------------------|-----------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| **Tardis.dev**    | `incremental_book.L2` + generated `depthSnapshot` (REST top-1000 stored in-stream) + bookTicker, forceOrder, OI polls | Tick-level; `depth@0ms` real-time since 2020-01-07; `pu`/`u` validated with reconnect-on-gap | Raw exchange WS payloads + local timestamps; REST/CSV; `tardis-machine` local replay; **`tardis-dev` Node client** | First day of each month, no API key; plans from ~$350/mo | **Best** — maps 1:1 into your `LogEvent` fold; same snapshot-in-stream + sequence-validation design you specified |
| **CryptoHFTData** | Snapshots + **every delta**, one row per price level, venue update IDs; sequence numbers where the venue sends them   | Tick deltas                                                                                  | Python SDK, CSV; free hourly sample                                                                                | Hourly sample                                            | Closest budget alternative — **verify Binance sequence coverage** before relying on it                            |
| **Kaiko**         | "Bids and asks": order-book snapshots **and updates**                                                                 | L2, daily CSV                                                                                | Institutional API / flat files                                                                                     | No                                                       | Enterprise normalized; less raw-WS fidelity                                                                       |
| **CoinAPI**       | L2 snapshots + updates, top-of-book, full-depth snapshots, real-time incremental                                      | Normalized across 400+ venues                                                                | REST / WebSocket / **FIX** + flat files                                                                            | Trial                                                    | Multi-venue normalization; FIX surface if you need it                                                             |
| **Crypto Lake**   | `book_1m` (20 levels/side), `deep_book_1m` (~full depth)                                                              | **1-minute snapshots** — not diffs                                                           | Python `lakeapi`, flat files                                                                                       | Yes                                                      | ML / liquidity-regime research; **cannot replay queue dynamics**                                                  |
| **CoinDesk Data** | Minute L2 snapshots                                                                                                   | 1-minute                                                                                     | REST                                                                                                               | Trial                                                    | Swing context only                                                                                                |
| **Coin Metrics**  | Order-book snapshots                                                                                                  | Snapshots                                                                                    | API / flat files                                                                                                   | Community                                                | Reference data, not microstructure                                                                                |
| **Amberdata**     | Incremental L2 (per comparison)                                                                                       | L2                                                                                           | API                                                                                                                | Trial                                                    | Alternative; verify Binance depth cadence                                                                         |

### Recommendation for your stack

1. **For the deterministic TS engine, Tardis is the only vendor whose data drops into your existing fold without a normalization layer** — raw WS-format diffs, generated snapshots stored in-stream, sequence validation, and a Node client (`tardis-dev`) plus `tardis-machine` for efficient local period replay . Its architecture independently validates your D1/D3 design. Use the free first-of-month samples to run your acceptance gate before subscribing .
2. **CryptoHFTData** is the budget alternative if its Binance delta coverage carries usable update IDs — run the same gate .
3. **Snapshots-only vendors (Crypto Lake, CoinDesk, Coin Metrics) are fine for swing/ML liquidity context but structurally cannot reproduce cancels, absorption, or queue evolution** — do not buy them expecting book replay .
4. **For live latency, no reseller beats a direct connection.** Vendors add a hop; for the scalp tier stay on Binance `/public` + `/market` WS (or SBE at 20 ms with an Ed25519 key). Third parties are for *history and research*, not the hot path.

**Acceptance gate before paying any vendor** (demand one symbol-day and test): stated schema (MBP vs MBO vs trades); no unexplained sequence gaps with documented recovery snapshots; event coverage including adds/modifies/cancels/trades/resets; exchange-event vs receive timestamps named with precision; point-in-time symbology; explicit research/derived-data rights; and a rebuilt top-of-book that reconciles against the vendor's own snapshots .

---

**Bottom line:** Binance's public historical surfaces are excellent for bars, trades, funding, and 5-minute context — free in bulk via Vision — but they impose hard walls (no L2 diffs, 30-day OI retention, <1-hour aggTrades windows, weight tiers that make tick-level REST backfill a multi-day operation, silent archive revisions, and shifting security classifications). The efficient response is a mutability-classed, weight-aware, single-flight cache backed by a checksum-pinned Parquet lake, with the cache strictly at the edge so replay stays deterministic. For the one dataset Binance never provides — sequenced incremental depth — Tardis is the highest-fidelity paid source and the only one that plugs directly into your TypeScript fold; everything else is either snapshots-only or requires a normalization layer you would then have to validate.

Understood. The constraint is now hard: **only Binance surfaces that are free — `NONE` (no key) or `MARKET_DATA` (API-key header, no signature) — plus the free Vision archive. No vendors, no subscriptions, no paid tiers.** I re-verified the current security classifications and the SBE surface against today's documentation, because this constraint changes what is in scope: several endpoints previously treated as "key-required extras" are now confirmed free-with-key, and one free surface (Spot SBE) is a genuine latency upgrade that most paid resellers do not match.

There is exactly one consequence of this constraint that no amount of engineering removes, and I state it up front rather than burying it: **historical sequenced L2 depth before your recorder's start epoch does not exist on any free Binance surface.** Spot has no book archive; futures `bookDepth` is 30-second banded snapshots; the USDⓈ-M `bookTicker` archive ended 2024-03-30 . Therefore your book-tier backtest epoch begins the day you start recording. Everything else — bars, trades, funding, OI/ratios, mark/premium/index, liquidations (COIN-M), and all live streams — is fully covered free. The plan below is built around that boundary.

---

## 1. The complete free surface inventory (verified current)

### 1.1 `NONE` — no key, no signature

| Surface               | What you get                                                                                                                                                                                             |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Futures WS `/public`  | `@depth@100ms` (250 ms default, 500/100 ms tiers), `@depth<levels>`, `@bookTicker`, `!bookTicker` — legacy `/ws`,`/stream` roots retired 2026-04-23; the split is confirmed in client-library changelogs |
| Futures WS `/market`  | `@aggTrade`, `@kline_*`, `@markPrice@1s`, `@ticker`, `@miniTicker`, `@forceOrder`, `@compositeIndex`, `!contractInfo`                                                                                    |
| Spot WS               | `stream.binance.com:9443` + market-only `data-stream.binance.vision`; `@depth@100ms`, `@aggTrade`, `@bookTicker`, `@trade`, klines, tickers                                                              |
| REST market data      | klines (full history), aggTrades, trades, depth (current snapshot), fundingRate (full history), premiumIndex, openInterest (current), exchangeInfo, time                                                 |
| Market-only REST host | `data-api.binance.vision` — fixed 13-endpoint subset, **excludes `historicalTrades`**                                                                                                                    |
| Vision archive        | Free bulk CSV/ZIP, daily T+1 / monthly first-Monday, SHA-256 `.CHECKSUM`, MIT                                                                                                                            |

### 1.2 `MARKET_DATA` — free with an API-key header (no signature, no subscription)

These are now confirmed in the current catalog, not assumptions:

| Endpoint / surface                                                         | Key requirement                                                                                                                        | Limits / retention                                                                                              |
|----------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| **Spot SBE market data streams**                                           | Ed25519 key in `X-MBX-APIKEY` header at handshake; **no timestamp, no signature, no extra permissions**; IP whitelist respected if set | 20 ms diff depth, 50 ms top-20 snapshots, real-time trades/bestBidAsk, µs timestamps                            |
| `GET /futures/data/openInterestHist`                                       | `X-MBX-APIKEY` required                                                                                                                | weight 0; 1000 req/5min/IP; **30-day retention**                                                                |
| `GET /futures/data/globalLongShortAccountRatio`                            | `MARKET_DATA`                                                                                                                          | weight 0; count-limited; 30 days                                                                                |
| `GET /futures/data/topLongShortAccountRatio` / `topLongShortPositionRatio` | `X-MBX-APIKEY` required (current catalog)                                                                                              | weight 0; **500 req/5min/IP shared**; 30 days                                                                   |
| `GET /fapi/v1/historicalTrades`, `GET /dapi/v1/historicalTrades`           | key required                                                                                                                           | weight 20; `fromId` pagination                                                                                  |
| Margin / mining-pub / portfolio / wallet lists                             | key header only                                                                                                                        | reference datasets (allAssets, allPairs, collateralRate, delist-schedule, open-symbol-list, algoList, coinList) |

Note the asymmetry: spot `historicalTrades` is now `NONE` (weight 25) in the current global catalog, while futures `historicalTrades` and the futures statistics ratios are `MARKET_DATA` . Re-read classifications from the live catalog at integration; do not trust older SDK defaults.

### 1.3 Vision archive — exact dataset map (verified against the live bucket)

| Product        | Datasets present                                                                                                                   | Missing / caveats                                                                                                                                         |
|----------------|------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| Spot           | `aggTrades`, `trades`, `klines` (all intervals incl 1s)                                                                            | **No book data of any kind**; timestamps µs from 2025-01-01                                                                                               |
| USDⓈ-M daily   | `aggTrades`, `trades`, `klines`, `markPriceKlines`, `premiumIndexKlines`, `indexPriceKlines`, `bookDepth`, `bookTicker`, `metrics` | `bookTicker` ends **2024-03-30**; `bookDepth` = 30 s banded snapshots (±0.2%…±5%), not levels; `metrics` = 5-min OI/L-S/taker; **no liquidation archive** |
| USDⓈ-M monthly | adds `fundingRate`                                                                                                                 | no daily fundingRate prefix                                                                                                                               |
| COIN-M daily   | all of the above **plus `liquidationSnapshot`**                                                                                    | —                                                                                                                                                         |
| Options        | `BVOLIndex`, `EOHSummary` only                                                                                                     | no trades/depth                                                                                                                                           |

Archives are silently corrected and re-uploaded — pin every `.CHECKSUM` into your manifest .

### 1.4 Free execution / telemetry (account features, not data subscriptions)

- WebSocket API `order.place` at `wss://ws-fapi.binance.com/ws-fapi/v1` (Ed25519 `session.logon`); testnet `wss://testnet.binancefuture.com/ws-fapi/v1`.
- `/private` user-data stream (listenKey + `ORDER_TRADE_UPDATE`/`ACCOUNT_UPDATE`) — free, key-required; this is your fill/position ground truth.
- Testnet REST `testnet.binancefuture.com`, streams `fstream.binancefuture.com` — free plumbing validation.

---

## 2. The free data plan, per tier

| Tier             | Backfill (free, full history)                                                                                                                                                          | Live (free)                                                                                                                                                                                    | Irreducible self-record                                                                  |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| **Swing**        | Vision klines/markPriceKlines/premiumIndexKlines/indexPriceKlines; REST `fundingRate` full history; Vision `metrics` (5 m OI/L-S/taker); Vision `bookDepth` bands for liquidity regime | `@markPrice@1s`, `@kline_1m/4h`; `openInterest` REST poll; `/futures/data/*` polls (key, 30 d window)                                                                                          | `openInterest` poll log → your own >30-day fine OI history                               |
| **Intraday**     | Vision `aggTrades`/`trades` full history; klines 1s spot / 1m futures                                                                                                                  | `@aggTrade`, `@kline_1m`, `@ticker`                                                                                                                                                            | aggTrade live for tick-exact CVD/book alignment                                          |
| **Scalp / book** | **None for L2.** Coarse proxies only (bookDepth bands + metrics + aggTrades) for hypothesis generation                                                                                 | Futures: `/public` `@depth@100ms` + `/market` `@aggTrade`,`@forceOrder`,`@markPrice@1s`; REST depth bootstrap. **Spot: SBE 20 ms diffs + 50 ms depth20 + bestBidAsk + trades (free with key)** | **depth diffs + aggTrade + forceOrder + bookTicker (or derive) + OI polls — from day 1** |

The scalp tier is the only one with a cold-start wall. Everything in the swing and intraday rows is backfillable to listing for free.

---

## 3. The free latency upgrade: Spot SBE (headline finding)

Because you accept free-with-key, **Spot SBE is now in scope and it is the best free market-data surface Binance offers** :

- `stream-sbe.binance.com` (or `:9443`); `/ws/<stream>` or `/stream?streams=…`; binary frames, JSON control frames.
- **`<symbol>@depth` diff updates at 20 ms** and **`<symbol>@depth20` snapshots at 50 ms** — 5× the temporal resolution of the 100 ms JSON feed .
- `<symbol>@bestBidAsk` (real-time, with auto-culling of stale events under load) and `<symbol>@trade` (real-time) .
- **All timestamps are int64 microseconds** (`utcTimestampUs` in the official schema) .
- Prices/quantities are **decimal floating point: `mantissa64 × 10^exponent8`**, not strings . This maps *directly* onto your D2 integer-tick grid — convert mantissa/exponent to scaled integers with no string parsing and no float drift. It is strictly better for determinism than the JSON feed.
- Diff depth uses the **same snapshot + update-ID continuity discipline** as JSON (the docs link the local-order-book procedure for the SBE diff stream) ; spot diff+snapshot sync semantics are confirmed independently . Decode field names from `spot_2_0.xml` (semanticVersion 5.2, littleEndian) at integration .
- Limits: 1024 streams/connection, 5 client msgs/s, 300 connection attempts/5min/IP, ping 20 s / pong 60 s, 24 h lifetime, `serverShutdown` event .

**Caveat that matters for your primary market:** SBE is **Spot-only**. There is no futures SBE surface — the binary streams are documented under Spot, and client libraries describe "Spot FIX/SBE … four binary market streams" . For USDⓈ-M futures, the free ceiling remains JSON `@depth@100ms` on `/public`. If you want 20 ms book resolution free, it is on spot; on futures you record 100 ms and accept that floor.

---

## 4. Cold-start and backtest protocol under the free-only constraint

This is where honesty is non-negotiable. You cannot buy pre-epoch L2 history, so the protocol makes the recorder the asset and gates trading deterministically until windows fill.

**Day-0 bootstrap order (all free):**

1. `exchangeInfo` → symbol specs (tick/step grids) + `rateLimits` (seed weight buckets).
2. `/fapi/v1/time` → clock offset.
3. Vision backfill: monthly archives for complete months, daily at range edges; verify `.CHECKSUM`; pin sha256 in manifest; promote to immutable Parquet .
4. REST `fundingRate` full-history pagination; klines/aggTrades tail top-up.
5. **Start the recorder immediately**: futures `depth@100ms` + `aggTrade` + `forceOrder` + `markPrice@1s` + `openInterest` polls; spot optionally SBE.
6. Bridge the book (snapshot + diff sync), then fill warm-up windows.
7. Enable tiers progressively: swing first (backfilled), intraday next, scalp only after book windows fill.

**Warm-up gates added to every rule pack (deterministic, event-time):**

```json
{
  "gates": [
    { "feature": "bookSynced",      "op": "==", "value": 1 },
    { "feature": "bookWindowMs",    "op": ">=", "value": 600000 },
    { "feature": "cvdAnchorSet",    "op": "==", "value": 1 },
    { "feature": "oiHistoryDays",   "op": ">=", "value": 7 },
    { "feature": "lagMs",           "op": "<",  "value": 250 }
  ]
}
```

`bookWindowMs` and `oiHistoryDays` are computed in-fold from recorded event time, so replay reproduces the gate exactly. No tier trades on an unfilled window.

**Backtest reality, stated plainly:**

- Book-tier signals (imbalance dynamics, cancel ratio, absorption, refill, depth-walk slippage) backtest **only from your recording epoch**. There is no free historical L2 to extend it backward.
- Pre-epoch research uses coarse free proxies — `bookDepth` bands + `metrics` + `aggTrades` — for liquidity-regime hypotheses. Label these **approximate**; they cannot reproduce queue evolution and must never be presented as deterministic book replay.
- Plumbing and sync correctness are validated on **testnet streams + synthetic golden fixtures** (gap injection, `pu` breaks, snapshot-too-old) — free, and sufficient to prove the engine before live data accumulates.
- The assets you build yourself become a proprietary free dataset: >30-day fine OI poll log, USDⓈ-M `forceOrder` log (no archive exists), spot SBE µs log, derived/recorded bookTicker. These accumulate at $0 data cost.

---

## 5. Rate, weight, and storage budget (computed for 3 futures symbols)

Futures IP `REQUEST_WEIGHT` pool = 2400/min = 3,456,000/day.

| Free activity                                              | Weight/day | % of pool | Count cap check                       |
|------------------------------------------------------------|------------|-----------|---------------------------------------|
| `openInterest` poll @5 s (weight 1)                        | 51,840     | 1.50%     | —                                     |
| `openInterest` poll @1 s (weight 1)                        | 259,200    | 7.50%     | —                                     |
| `openInterestHist` @1 min (weight 0)                       | 0          | 0%        | 4,320/day vs 288,000/day cap          |
| Top-trader L/S ratios @1 min (weight 0)                    | 0          | 0%        | 8,640/day vs 144,000/day shared cap   |
| Depth snapshot resync, worst case 1/symbol/2 s (weight 20) | 2,592,000  | 75%       | rare; min-interval + backoff enforced |
| aggTrades tail warm-up at boot (weight 20)                 | 60         | ~0%       | one-shot                              |

The plan is comfortably inside free limits at 5 s OI cadence; even 1 s OI is 7.5%. The only pressure point is a resync storm, which the per-symbol min-interval + exponential backoff (and 429 `Retry-After` / 418 handling) already caps. SBE spot: 3 symbols × 4 streams = 12 streams → one connection (cap 1024) .

Storage (zstd, per symbol/day): minimal live set ~85–507 MB (depth dominates, from the prior computation); added self-recorded assets are negligible — OI@5 s ~0.6 MB, ratios@1 min ~0.04 MB, forceOrder <1 MB. SBE spot trades 5× temporal resolution (4.32 M depth msgs/day vs 864 k at 100 ms) but binary mantissa/exponent encoding is far smaller per message than JSON, so compressed volume stays comparable . Vision backfill and all egress from the public bucket are free.

---

## 6. Architecture deltas vs the prior design (vendor paths removed)

- **Registry:** add a Spot SBE row — `security: MARKET_DATA (key-header, Ed25519, no signature)`, `product: spot`, streams `@trade/@bestBidAsk/@depth(20ms)/@depth20(50ms)`, `timeUnit: microseconds`, `encoding: mantissa64×10^exponent8`. Keep futures rows on `/public` + `/market`. Delete every vendor/Tardis module.
- **Ingest:** add an optional SBE shard for spot (handshake with `X-MBX-APIKEY` header; decode per `spot_2_0.xml`; convert mantissa/exponent straight to the integer grid). Add REST poll-log events for `openInterest`, `/futures/data/*` ratios, and `forceOrder` — each written into the per-symbol `LogEvent` stream so replay reproduces them (D1).
- **Core:** unchanged folds; add `bookWindowMs`, `oiHistoryDays`, `cvdAnchorSet` features and the warm-up gates above.
- **Cache:** origins are now exclusively Vision S3 (conditional GET + checksum), Binance REST, and ws-fapi — all free. Mutability-classed TTLs, single-flight, weight buckets seeded from `exchangeInfo.rateLimits`, negative caching for −1121/451. Cache stays at the edge; replay reads the log, never the cache (D6).
- **Execution:** Ed25519 `session.logon` on ws-fapi for the scalp tier; REST fallback; `/private` fills folded into portfolio state.

**Key setup checklist (free, one key):**

1. Create an **Ed25519** API key (required for SBE and ws-fapi session logon) .
2. Enable *Reading* + *Futures/Spot trading* as needed; **no withdrawals**.
3. SBE needs **no extra permission** beyond a valid key; `MARKET_DATA` REST needs only the header .
4. IP whitelist optional but recommended (SBE respects it) .
5. Time-sync only matters for signed order requests; SBE and `MARKET_DATA` reads need no timestamp/signature.
6. Separate testnet keys for plumbing validation.

---

## Bottom line

A fully free, deterministic, three-tier engine is viable on Binance alone. The constraint costs you exactly one thing — **pre-epoch historical L2 depth** — so the recorder is not optional infrastructure, it is the asset, and it starts today. Everything else is covered: swing and intraday context backfills to listing for free via Vision + REST; the scalp tier runs on free live streams, with **Spot SBE giving you 20 ms diffs and microsecond timestamps at no cost beyond an Ed25519 key header** — a surface most paid resellers do not even match . Futures stays at the free 100 ms JSON floor, which is the honest retail ceiling there. No subscription, no vendor, no signature on any market-data read: just a key header where Binance requires one, a checksum-pinned free archive for history, and your own append-only log for the one dataset Binance never gives away.

Interpreting the truncated first question in line with your standing constraint: **reliable APIs that are free — requiring either no key or only a free API key — with no paid subscription or vendor.** All three answers below are filtered through that constraint and verified against current sources. The headline finding for your free-only mandate: **OKX publishes a genuinely free historical L2 order-book archive** (different venue from Binance), and the open-source backtesting engines that replace paid vendors are now mature enough to plug directly into your deterministic, event-sourced design.

---

## 1. Reliable free APIs (no key, or free key only)

### 1.1 Exchange-native — the deepest free data, and the only correct hot-path sources

| API                                 | Auth for market data                                                                                                                                                   | Free data depth                                                                                      | Historical (free)                                                                                                                                                           | Key limits / caveats                                                                                |
|-------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| **Binance**                         | `NONE` for most; `MARKET_DATA` (key header, no signature) for futures `historicalTrades` + `/futures/data/*` ratios; **SBE needs an Ed25519 key header, no signature** | Spot SBE 20 ms diffs / 50 ms snapshots / µs; futures JSON `@depth@100ms`; full trades/klines/funding | **Vision** bulk archive (free, MIT); spot has no book archive; futures `bookDepth` is 30 s bands                                                                            | Established in prior turns; Ed25519/RSA asymmetric keys supported                                   |
| **OKX**                             | Public REST/WS, no key                                                                                                                                                 | WS `books` 400 levels @100 ms; trades, funding, OI                                                   | **Free official archive: tick trades from Sep 2021, OHLC from Jul 2023, funding from Mar 2022, high-resolution L2 order book from Mar 2023, borrowing rates from Dec 2021** | L2 is 400-level (5000-level from 2025-11-01), ~T+3 publication ; WS API connection limit 3 req/s/IP |
| **Bybit V5**                        | Public market data **no key**; WS market data **not counted against rate limits**                                                                                      | `orderbook`/`trade`/`ticker` public topics                                                           | Recent via REST; no deep free L2 archive                                                                                                                                    | Public streams need no credentials                                                                  |
| **Kraken**                          | `/0/public/*` **no auth**                                                                                                                                              | Trades, OHLC, depth, WS public                                                                       | **OHLC returns only 720 data points** of the requested interval — shallow                                                                                                   | Per-key decaying rate counters                                                                      |
| **Coinbase Exchange**               | **Market Data APIs are public** (no auth); trading requires auth                                                                                                       | Product candles/trades/book, WS                                                                      | Candles paginated (1m–1d buckets)                                                                                                                                           | Public methods need no credentials                                                                  |
| **Deribit**                         | Public JSON-RPC over HTTP/WS, no key for market data                                                                                                                   | Options/futures books, ticker greeks, mark, IV, DVOL, OI                                             | **Real-time trades only from subscription moment; REST past trades limited**                                                                                                | Best free live options surface; history is vendor territory                                         |
| Bitget / Gate / MEXC / HTX / BitMEX | Public market data, no key                                                                                                                                             | Books/trades/klines per venue                                                                        | Recent only                                                                                                                                                                 | Verify per-venue quotas at integration                                                              |

### 1.2 Aggregators / reference — free tiers for metadata, sentiment, cross-venue context (never the hot path)

| API                    | Free tier (verified where noted)                                                                                                                                  | Use                                              |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------|
| **CoinGecko Demo**     | Free, one key, **100 calls/min, 10,000 calls/month**, freshness from ~60 s; 4xx/5xx count toward the limit ; keyless public plan is only 5–15 calls/min, variable | Metadata, market caps, cross-venue price context |
| DefiLlama              | Free, no key                                                                                                                                                      | TVL, yields, stablecoins, protocol fundamentals  |
| CoinPaprika / CoinCap  | Free tiers (key optional)                                                                                                                                         | Reference prices, supply, metadata               |
| CryptoCompare          | Free key tier                                                                                                                                                     | News, sentiment, reference rates                 |
| Coin Metrics Community | Free                                                                                                                                                              | Reference rates, network metrics                 |
| Alternative.me         | Free, no key                                                                                                                                                      | Fear & Greed index                               |

These are reliable for *context*, not tick data: quotas are small, freshness is delayed (CoinGecko ~60 s ), and there is no SLA. Keep them out of the deterministic fold's hot path; poll them as logged, slow-cadence context events.

### 1.3 Free historical archives — the decisive comparison

| Archive                     | Free L2 diffs?                                                               | Coverage                                                                |
|-----------------------------|------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| **OKX historical data**     | **Yes — high-resolution L2 from Mar 2023** , 400/5000 levels                 | Trades Sep 2021+, funding Mar 2022+, OHLC Jul 2023+                     |
| Binance Vision              | **No** — spot has no book data; futures `bookDepth` is 30 s banded snapshots | aggTrades/trades/klines/funding/metrics full history (prior turns)      |
| Kraken / Coinbase / Deribit | No                                                                           | Shallow REST history (Kraken 720 points ; Deribit limited past trades ) |

**Implication for your free-only mandate:** if you want free *pre-recorded* historical L2 for microstructure research, **OKX is the only major venue that publishes it** . For Binance L2 specifically, no free archive exists — your recorder remains the sole source, exactly as established. OKX's free L2 is excellent for developing/validating book-feature logic on a different venue before your Binance recordings accumulate.

**Reliability rule:** for the deterministic scalp/intraday hot path, only exchange-native WebSocket feeds are reliable and low-latency free sources. Aggregators and REST history are for backfill and context. Free tiers have no SLA, variable keyless limits , and publication lag (OKX ~T+3 ) — design around them, don't depend on them for live decisions.

---

## 2. Securing API keys in public applications

### 2.1 The public-app reality (state this plainly)

**A secret embedded in a public/client-side application is not a secret.** Anything shipped to a browser, mobile app, or desktop binary is extractable. Therefore:

- **If the app only reads public market data, ship zero keys.** Binance `NONE` endpoints and `data-api.binance.vision` require no key at all (prior turns). This is the correct default for a public data dashboard.
- **If a key is unavoidable** (futures `MARKET_DATA` ratios, SBE, trading), it lives **only on your backend**. The public client calls your proxy; the proxy attaches the key. Never put `X-MBX-APIKEY`, a private key, or a signature in frontend code, client-side env vars (`NEXT_PUBLIC_*` are public), or mobile bundles.

```
public client ──► your backend proxy ──► exchange
                  (keys, signing,        (NONE / MARKET_DATA / signed)
                   rate-limit, audit)
        ▲ never ships secrets to the client
```

### 2.2 Binance key configuration checklist (verified guidance)

1. **Use a self-generated Ed25519 key pair.** Binance recommends an Ed25519 private key protected with a passphrase as the most secure, best-performing option ; you upload only the public key, so the private key never leaves your server .
2. **IP-whitelist every key** — not just withdrawal keys .
3. **Least privilege:** create read-only first; enable trading only where required; **disable withdrawals** .
4. **Separate keys per service and environment:** ingest (read-only) ≠ execution (trade) ≠ testnet. A leaked ingest key must not be able to trade.
5. **Sign locally; never transmit the private key.** Ed25519 signatures are per-request; keep `recvWindow` small and sync server time for signed endpoints.
6. SBE and `MARKET_DATA` reads need only the key header (no signature) — but the key ID is still a credential: whitelist it, monitor it, revoke it on abuse .

### 2.3 Secrets lifecycle

- Store keys in a secret manager / encrypted env (Vault, SOPS+age, cloud KMS) — **never in the repo**. Commit only `.env.example`; `.gitignore` all real `.env`/key files.
- Encrypt at rest; restrict access by IAM; inject at runtime, not baked into images.
- **Rotate on a schedule and immediately on any suspicion**; revoke unused keys; audit the key list periodically.

### 2.4 Repo / CI hygiene for `@nemesis-oss`

The standard open-source pattern is **Gitleaks as a pre-commit hook + TruffleHog in CI** , scanning the full git history once, with GitHub push protection enabled and immediate rotation on any leak . Add `detect-secrets`/`git-secrets` as complementary scanners . For npm publishing: whitelist published files, never publish `.env`/keys, and use provenance.

A concrete reference model worth copying: **NautilusTrader's own supply-chain pipeline** runs Gitleaks secret scanning and Zizmor workflow auditing pre-commit, CodeQL, `cargo-audit`/`cargo-vet`/`cargo-deny`/`pip-audit`/OSV-Scanner, SHA-pinned CI actions, SLSA build provenance, Sigstore-attested SBOMs, cosign-signed images, and OIDC trusted publishing . That is a production-grade, fully open-source security posture you can mirror for your SDK family.

### 2.5 Logging, telemetry, and bearer tokens

- **Redact** `X-MBX-APIKEY`, signatures, private keys, and `listenKey` from all logs/traces/error reports.
- **Never log full signed URLs** — query-string signatures leak via logs and `Referer` headers; prefer header/body signing.
- A **`listenKey` is a bearer token** for the user-data stream: protect it, keep it alive via `userDataStream.ping`, never log it, and drop/recreate on exposure.
- TLS everywhere; no keys in URLs/query for signed requests.

### 2.6 Monitoring and per-user isolation

- Alert on anomalous key usage (unexpected IP, permission, or call volume); revoke + rotate automatically on suspicion.
- For a public app serving many users, **never share one master key**: use per-user OAuth/scoped tokens, isolate keys per user, and rate-limit the proxy per user.

---

## 3. Open-source alternatives to paid API vendors

### 3.1 The honest boundary first

Open-source software replaces paid vendor **tooling and plumbing** — it cannot conjure data the exchange never published. **No OSS project gives you free pre-epoch Binance L2 history**; that still comes only from your own recorder or a free exchange archive (OKX). Also beware the trap: an open-source *client* (e.g., `tardis-node`) does not make the *data* free. The real vendor替代 is: **official free archives + self-recording + OSS engines**.

### 3.2 OSS by role (licenses verified where stated)

| Role                                      | Project                                                                                                                                                                                                                                                                                     | What it replaces                    | Notes                                                                                                                                                                                              |
|-------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Free data + official connectors**       | `binance-public-data` (MIT), `binance-spot-api-docs` (public SBE/FIX schemas), official Binance connectors; **OKX historical-data**                                                                                                                                                         | Paid data vendors                   | OKX L2 archive is free ; Binance schemas public (prior turns)                                                                                                                                      |
| **Unified live feeds**                    | **ccxt** (100+ exchanges), **cryptofeed** (XFree86-style permissive license, normalized WS feeds, 40+ exchanges) , **cryptostore** (storage + real-time restream via cryptofeed)                                                                                                            | Paid normalized-feed vendors (live) | cryptofeed→cryptostore is a direct OSS live-data pipeline; QuestDB documents ingesting tick data with cryptofeed                                                                                   |
| **Book-faithful backtest / live engines** | **hftbacktest** (**MIT**, Rust+Python, L2 MBP + L3 MBO full book reconstruction, **feed/order latency + queue-position fill models**, live bots for **Binance Futures and Bybit** using the same algo code, complete Binance Futures backtest example)                                      | Paid HFT backtest platforms         | Its philosophy — backtest of a period must closely reproduce live results — is exactly your D6 contract                                                                                            |
|                                           | **NautilusTrader** (open-source core engine, Rust+Python, **identical core across backtest and live**, `nautilus-event-store` for event sourcing/replay, `nautilus-binance` adapter, L2/L3 books, Binance order-book-depth backtest tutorial, latency/slippage/partial-fill/queue modeling) | Paid backtest/live infra            | **Use the `nautilus-binance` adapter (free exchange data); the `nautilus-tardis`/`coinapi`/`databento` adapters require paid data** . Pro/Cloud tiers are optional — the engine itself is free OSS |
|                                           | **Lean / QuantConnect** (OSS engine, Binance brokerage plugin); **freqtrade** (free OSS Python bot, built-in historical **data download** + backtesting + live)                                                                                                                             | Paid bot/backtest platforms         | freqtrade downloads free exchange data for backtests                                                                                                                                               |
| **Storage / analytics**                   | DuckDB, Apache Arrow/Parquet, QuestDB, TimescaleDB, ClickHouse, Redis, NATS                                                                                                                                                                                                                 | Paid data platforms                 | Your Parquet-lake + DuckDB design already uses these                                                                                                                                               |
| **Decoding**                              | `real-logic/simple-binary-encoding` (SBE), QuickFIX (FIX); Binance public SBE/FIX schemas                                                                                                                                                                                                   | Paid SBE/FIX tooling                | Decode SBE mantissa/exponent straight to your integer grid (prior turns)                                                                                                                           |
| **Secrets / security**                    | Gitleaks , TruffleHog , detect-secrets/git-secrets , Vault, SOPS, age                                                                                                                                                                                                                       | Paid secret-scanning/management     | Gitleaks pre-commit + TruffleHog CI is the standard pattern                                                                                                                                        |
| **Curated reference**                     | `awesome-systematic-trading`                                                                                                                                                                                                                                                                | —                                   | Curated OSS list                                                                                                                                                                                   |

### 3.3 Recommendation for your TypeScript, deterministic, free-only stack

- **Hot path:** your own direct Binance WS shards (`/public` + `/market`, SBE for spot) — not a normalized wrapper. ccxt/cryptofeed are for **cross-venue context and scanning**, where their normalization is a benefit and their extra hop is acceptable.
- **Backtest/live engine:** **hftbacktest (MIT)** or **NautilusTrader (OSS core)** — both model queue position and latency, both reconstruct L2/L3 books, and both can be fed your own recorded log/Parquet. NautilusTrader's event-store + identical-backtest/live core is the closest OSS match to your event-sourced D6 design ; hftbacktest's Binance Futures live bot and complete backtest example are the most direct starting point .
- **Storage:** DuckDB + Parquet (already in your design); QuestDB/TimescaleDB if you want a dedicated TSDB .
- **Security:** Gitleaks + TruffleHog + Vault/SOPS, mirroring NautilusTrader's supply-chain pipeline .
- **Data:** Binance Vision + **OKX free historical L2** for research  + your self-recorder for Binance L2.

---

## Bottom line

A fully free, no-subscription stack is not just viable — it is now well-supported by mature open-source tooling. For **data**, exchange-native free surfaces (Binance `NONE`/`MARKET_DATA`/SBE, OKX, Bybit, Kraken, Coinbase, Deribit) plus free archives (Binance Vision, and **OKX's free historical L2 from March 2023** ) cover everything except pre-epoch Binance L2, which only your recorder can supply. For **keys in public apps**, the rule is absolute: no secret ships to the client — prefer keyless public endpoints, otherwise a server-side proxy with self-generated Ed25519 keys, IP whitelisting, least privilege, no withdrawals, and Gitleaks/TruffleHog scanning . For **vendor替代**, open-source engines (hftbacktest MIT, NautilusTrader OSS core, ccxt, cryptofeed/cryptostore, freqtrade) replace paid tooling outright — just remember that OSS replaces the *plumbing*, never the *unpublished data*, and that an OSS client for a paid feed is still a paid feed.

## Decision: extend the existing stack. Do not create a new bot.

I inspected both repositories before answering, and the evidence is decisive. Your existing `crypto-trading-agent` **plus** `@nemesis-oss/binance-sdk` already implement roughly 90% of the deterministic, event-sourced, replay-equivalent, LLM-advisory, risk-gated, local-first architecture we converged on across the previous turns — at production quality, with tests, and with the SDK released **today (v3.6.1, 21 Nov 2026)**. A new repo would discard that and re-introduce the exact failure modes (float drift, LLM in the hot path, nondeterministic replay, unsafe order retries) this stack has already engineered away. The correct unit of new work is **a new module/package inside the existing monorepo and SDK family**, not a new agent.

This is not a stylistic preference; it is what the source shows.

---

## 1. Why: the architecture we designed already exists here

Mapping each requirement from our prior design to the verified implementation:

| Design requirement (prior turns)                                                                                               | Already implemented                                                                                                                                                                                                   | Evidence                                                                                   |
|--------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| Machine-readable registry (REST + WS, security `none/apiKey/signature`, weights, stream ceilings)                              | `contracts/endpoint-catalog.json`, `security-catalog.json`, **`websocket-catalog.json`**, CI-validated against Binance Postman collections                                                                            | `@nemesis-oss/binance-sdk` README "Endpoint maps"; this *is* the turn-1 catalog work       |
| Book: REST snapshot + `@depth@100ms` diffs, `pu` gap detection, self-heal resync, microprice/imbalance/spreadBps/depth metrics | `createFuturesOrderBookEngine()`, `usdm.books.watch()`; tests cover `pu == lastUpdateId`, `orderBook.desync` → async resync, `sync.failed`                                                                            | SDK README "Local order books"; `test/state/OrderBookEngine.test.ts`                       |
| **D2 integer/fixed-point grid**                                                                                                | **BigInt-backed `Decimal`** (`0.1+0.2===0.3`), `parseJsonLossless` (IDs > 2^53 preserved), `core/fixedpoint` zero-dep BigInt quantizers replacing the float path                                                      | SDK commit #93 "exact fixed-point filters"; README "Exact numbers"                         |
| WS lifecycle: state machine, race-free reconnect, 24 h recycle, subscription repair                                            | `IDLE→…→CLOSED`, **proactive T-23 h rotation with no data gap**, `LIST_SUBSCRIPTIONS` drift repair, `subscribe()` resolves on server ack                                                                              | SDK README "Reliability / WebSocket lifecycle"                                             |
| Weight-aware scheduler + ban handling                                                                                          | `RateLimitTracker` (parses `X-MBX-USED-WEIGHT-*`, preempts `-1003`) **and** agent `RestGuard` (`-1003`/418/429/`Retry-After`/`banned until`, refuse at 90% of 2400, process-wide IP state)                            | SDK README; agent `src/core/adapters/binance/restGuard.ts`, `docs/WS_FIRST_MARKET_DATA.md` |
| **Deterministic idempotent execution**                                                                                         | `newClientOrderId` derived from `intentId` (exchange = idempotency guard), transport-failure reconciliation via `origClientOrderId`, `-2013` → one safe resubmit, ambiguous → `ExecutionUnknownError` (never a guess) | SDK README "Execution (idempotent placement + reconciliation)"                             |
| Risk gates + key safety                                                                                                        | `RiskGateway`: `dryRun` (never synthetic success), `readOnly`, allowlist, notional/leverage caps, `maxDailyLoss` UTC kill-switch, rejection-streak breaker, **`allowWithdrawals:false` by default**                   | SDK README "Agent safety"                                                                  |
| Depth-walk slippage / fee / latency fill models                                                                                | `OrderBookModel` (VWAP walks against real/injected book), `SlippageModel`, `PartialFillModel`, `LatencyModel`, `BinanceUsdmFeeModel`                                                                                  | SDK README "Paper trading"                                                                 |
| **D1/D5 event log + audit**                                                                                                    | `client.events` bus (`ts/seq/scope/name/payload`), `StreamAuditSink` (append-only JSONL), `orderBook.synced/desync`, `execution.*`, `risk.*`                                                                          | SDK README "Observability", "Execution audit sink"                                         |
| **D6 backtest ≡ live**                                                                                                         | `ReplayService` runs the **same agents/fusion/risk/learning** as the live loop; no-lookahead feed; conservative intrabar stop-before-target; `CandidateFlow`/`DecisionJournal` shared with replay                     | agent README "Backtesting", `src/backtesting/`, `src/decision/`                            |
| LLM strictly advisory, off the hot path                                                                                        | advisor veto **fail-closed on parse** (#6); council **detached from the tick loop**, schema-validated, never invents a price, `LLM_COUNCIL_AUTOTRADE` refused until an expectancy gate exists                         | agent README "Multi-persona agentic AI", `src/ollama/advisor.ts`                           |
| Paper-only core boundary                                                                                                       | `src/core` refuses `MODE!=paper` at startup; **`tests/core.architecture.test.ts` walks the import graph and fails if a live-order module becomes reachable from the core**                                            | agent `package.json` (`paper:core`), README                                                |
| Promotion only on measured evidence                                                                                            | `live-readiness.ts`: ≥100 trades/≥150 days + ≥50 paper/≥30 days, positive 90% lower-bound net expectancy; `MODE=live` trades only `strategy-approvals.json`                                                           | agent README "Live gate"                                                                   |
| Recorder + migrated WS URLs                                                                                                    | `record-market-data.ts` (public streams, no keys); route probe **empirically confirmed** legacy `/ws/@aggTrade` silent, `/market/stream` streams                                                                      | agent `docs/WS_FIRST_MARKET_DATA.md` (probe 2026-11-17)                                    |
| Event-sourced research + state machine                                                                                         | `ResearchEventBus` (monotonic seq), JSONL audit "replay to reconstruct any past state", `ChampionRegistry` `ALLOWED` table, `IllegalTransitionError`                                                                  | agent `src/research/Events.ts`, `improvements.md`                                          |

Scale of what you would throw away: **~1,518 SDK tests (139 files) + ~2,591 agent tests**, a contract-coverage gate, OIDC trusted publishing, ESLint/CodeQL pre-commit, and an honest research log. That last item matters: the repo already records *"no strategy family has a demonstrated edge after costs; the entries are the problem."* A new bot resets that evidence to zero.

---

## 2. The actual delta — small and surgical

These are the genuine gaps versus our design. All are extensions of existing primitives, not a rewrite:

1. **Raw tick-level recording + tick-level book replay (the irreducible asset).** The current recorder writes **1-minute aggregates** (~3 MB/symbol/week); the book engine is live-only. There is no append-only raw `depth`-diff + `aggTrade` log feeding a sub-second replay. Build a recording tap on the SDK's `ws` message bus using `parseJsonLossless` → per-symbol/hour JSONL with `seq/ts`, plus a replay adapter that feeds recorded frames into the **same** `OrderBookEngine` and the agent's `ReplayService`. The SDK already has `OrderBookModel` for injected books and `StreamAuditSink` — this is mostly wiring.
2. **Convert context depth to WS + dedupe sockets.** `WS_FIRST_MARKET_DATA.md` states order-book depth in `MarketDataService` is still REST (1/symbol/60 s): *"A partial-depth stream exists on `/public`. Not converted in this pass."* Outstanding decision #3: orchestrator/fleet/run-fleet each open their own kline socket → a process-wide registry should share one.
3. **Seed the weight guard from `exchangeInfo.rateLimits`.** The doc admits the 2400 limit is the hardcoded default, *"not read from the account's `rateLimits`."* The SDK exposes `rateLimitWeightPerMinute` and declared contract weights — wire them.
4. **Two policy decisions, not code:** derivatives TTL (60 s vs 300 s freshness/cost tradeoff) and whether reduce-only protective writes bypass a REST backoff (decision #2).
5. **Warm-up gates** (`bookWindowMs`, `oiHistoryDays`) for the scalp tier — the friction gate already fails closed while the book is not live; add explicit window-fill gates to the rule packs.
6. **Bump the SDK pin.** The agent pins `@nemesis-oss/binance-sdk: 3.2.0`; latest is **3.6.1**. Bumping picks up exact fixed-point filters (#93), pre-flight validators, typed user-data events, and the latest contract drift. Also consolidate the duplicate `binance@^2.15.22` dependency onto your own SDK to avoid two WS stacks.

Home for the new work: a workspace package (e.g. `@nemesis-oss/binance-marketdata`) or `src/core/marketdata/tick`, built **on** the SDK and **inside** the paper-core import boundary. The SDK (MIT) is the natural home for the recorder/replay primitives; the agent (proprietary) consumes them.

---

## 3. "Only local please for now" — the stack is already local-first

Verified local defaults: in-memory `PaperEngine`, local `data/*.jsonl`, local Ollama (`config.ts` default `http://127.0.0.1:11434`), local Ink TUI, local dashboard (ports 4101/5173). Concrete local-only settings:

- **Run `npm run paper:core`** (`src/core/main.ts`, paper-only). Note `dev:paper` has a `predev` hook that auto-starts the `paper_exchange` Rails docker broker; for pure local in-memory paper, use the core entrypoint and leave `PAPER_EXCHANGE_URL` unset.
- **Ollama local:** `OLLAMA_HOST=http://127.0.0.1:11434`, local model (`gemma4:31b` default). The fleet's Nov-8 commit defaults to **Ollama Cloud** (`https://ollama.com`, `beam`, rotating `OLLAMA_API_KEY_n`) — for local-only, keep `FLEET_ENTRIES=off` or point the fleet at the local daemon. Local hosts are the SDK's happy path: JSON `format` mode is requested only against local hosts.
- **Storage local:** keep `data/` JSONL; add local DuckDB→Parquet compaction (no S3/Glacier). `pg` is a dependency — use a local Postgres only if needed; JSONL suffices for now.
- **Secrets local:** `.env` (zod-validated), `age`/SOPS or OS keychain, **Gitleaks pre-commit + TruffleHog CI** ; the SDK already runs ESLint pre-commit. Use an **Ed25519** key (SDK supports `privateKey` + `signatureAlgorithm`), IP-whitelist it, withdrawals denied by `RiskGateway` default .
- **Execution:** `MODE=paper`; when ready, `npm run verify:testnet` (`BINANCE_TESTNET=on`) before any live; live trades nothing without an approvals file.
- **Backfill locally from Vision S3** (free, public) rather than `fapi` REST — see the caveat below.

### Two honest local-only caveats (verified in your own repo)

- **Geo/451:** `WS_FIRST_MARKET_DATA.md` records *"The backfill returned HTTP 451 from `fapi.binance.com` in this container."* So locally, **public WS streams work** (kline frames were received) but **futures REST backfill may be geo-blocked**. Mitigation already partly built: `KlineStreamCache` falls back to WS-only when REST refuses, and `RestGuard` refuses gracefully. For history, pull the free Vision archives (S3, public) instead of `fapi`. Confirm your local egress reaches `/public` and `/market`.
- **Latency:** a local machine's RTT to Binance's Tokyo matching engine bounds the scalp tier. Intraday and swing are fine locally; true low-latency scalping would later need a Tokyo host. "Local for now" is correct for development, research, and paper — do not represent it as HFT-grade.
- **SBE watch-item:** your SDK's contract-drift log (Nov 18) quotes a spot CHANGELOG entry `33186bb 2026-10-30 — SBE retirement`. Re-verify SBE availability before relying on my earlier 20 ms suggestion; futures has no SBE regardless. This tempers the prior turn's SBE recommendation.

---

## 4. When a new repo *would* be justified (none apply here)

Create a new bot only if you need: a fundamentally different runtime/language; a clean-room rewrite to escape licensing (the **agent is proprietary AlgoScalperAPI**, the **SDK is MIT** — so reuse the SDK freely, extend the agent as its owner); or a genuine product split. None of these is your situation. You are adding a raw-tick recorder and tick-level replay to a stack that already has the book engine, fixed-point math, idempotent execution, registry, replay, risk gates, and promotion discipline.

If you want an external cross-check of your fill models rather than a new bot, `hftbacktest` (MIT, L2/L3, queue-position + latency, Binance examples) is a useful open-source reference to validate against  — and OKX's free historical L2 archive is a free research venue for book-feature logic while your Binance recordings accumulate . Neither replaces your agent.

---

## 5. Concrete local build order (extend, don't rebuild)

1. Bump `@nemesis-oss/binance-sdk` 3.2.0 → 3.6.1; consolidate the `binance` dependency; `npm run check` (typecheck + build + test).
2. Add the raw-tick recorder tap on the SDK `ws` bus (`depth@100ms` + `aggTrade` + `bookTicker` + `forceOrder` + `markPrice@1s`), lossless JSONL per symbol/hour with `seq/ts`; start it **today** beside `paper:core`.
3. Add a replay feed adapter into `OrderBookEngine` + wire the agent `ReplayService` to the tick log for the scalp tier; assert live ≡ replay frame hashes (your D6).
4. Convert `MarketDataService` context depth to the `/public` diff stream; add a process-wide socket registry (decision #3); seed `RestGuard` from `exchangeInfo.rateLimits`.
5. Add warm-up gates to the rule packs; decide derivatives TTL and protective-write bypass.
6. Backfill Vision locally (checksum-pinned); run `micro:eval`, `research:golden`, `analyze-flow` on accumulating recordings.
7. `verify:testnet`; live only through `live-readiness --write-approvals`. Keep the LLM advisory and the paper-core import boundary intact throughout.

---

**Bottom line:** use the existing `crypto-trading-agent` on `@nemesis-oss/binance-sdk`. It already embodies the deterministic, local-first, LLM-advisory design with a CI-validated registry, self-healing sequence-checked books, BigInt fixed-point math, idempotent reconciled execution, full-system replay, and a measured-evidence promotion gate. The only missing piece is the one we identified as irreducible — a **raw tick-level depth/trade log and tick-level book replay** — and that is a new module on top of existing SDK primitives, not a new bot. Configure it local-only (`paper:core`, local Ollama, local JSONL/Parquet, local secrets), backfill from Vision because `fapi` REST is 451-blocked in your environment, and be honest that local latency bounds the scalp tier. Start the raw recorder today; every day it runs is book history you can never recover for free.

I re-read `.env.example`, `src/core/main.ts`, `tests/core.architecture.test.ts`, and `.github/workflows/ci.yml` before answering. One correction to my previous message is required, and it changes the local-only instructions materially — I flag it explicitly in §2 rather than quietly revising it.

---

## 1. Specific advantages of using the existing repository

These are not generic "reuse is good" arguments; they are concrete guarantees verified in the source, several of which are expensive to recreate and rare in trading codebases.

**A. Live-order safety is structural and test-enforced, not conventional.** `tests/core.architecture.test.ts` walks the runtime import closure of `src/core` and asserts:
- the core reaches only three legacy modules (`binance/indicators.ts`, `binance/paperExchangeClient.ts`, `ollama/jsonMode.ts`);
- no live-execution module (`client.ts`, `liveEntry/liveBook/liveProtection/liveJournal`, `userDataStream`, `remoteBroker`, `ExecutorAgent`, `Orchestrator`) and no live-capable package (`binance`, `@nemesis-oss/coindcx-sdk`) is reachable;
- the only non-`node:` packages the core loads are `@nemesis-oss/binance-sdk`, `@nemesis-oss/ollama-sdk`, `dotenv/config`, `zod`;
- core source names no order-placing surface (`futures.execution/trading/account/userStream`, `placeOrder`, `createOrder`) and no trading credential (`BINANCE_API_KEY/SECRET`, `apiSecret`);
- the client the core builds is `createReadOnlyBinanceClient`, and the test asserts `placeOrder`/`createOrder`/`cancelAllOpenOrders` all reject with `PolicyViolationError` `/readOnly/`.

This means a prompt-injected or buggy LLM cannot spend the account from the paper core — the impossibility is proven by CI, not promised in a README.

**B. Clean hexagonal architecture with inward-dependency tests.** The same file enforces `domain ← ports/events ← application ← adapters ← composition`; strategies may import only `domain` + `zod`; SDK imports are confined to adapters; the Ollama advisor adapter cannot reach execution, sizing, or risk. Customization has a guaranteed-safe seam.

**C. Deterministic replay parity already exists.** `ReplayService` runs the *same* agents/fusion/risk/learning as the live loop; `CandidateFlow`/`DecisionJournal` are shared with replay; the backtest is strictly causal (closed-candle decisions, next-bar-open fills, conservative stop-before-target). This is your D6 contract, implemented.

**D. The SDK primitives you would otherwise rebuild are done** (`@nemesis-oss/binance-sdk` v3.6.1, released today): self-healing sequence-checked L2 books (`pu` gap → resync), BigInt fixed-point money math, lossless JSON for IDs > 2^53, idempotent `intentId`-derived execution with reconciliation (never blind-retries a placed order), `RiskGateway` (withdrawals denied by default), WS state machine with T-23h rotation and subscription-drift repair, `RateLimitTracker`, append-only `StreamAuditSink`, a CI-validated `contracts/` registry (endpoint/security/websocket catalogs), and paper fill models including `OrderBookModel` VWAP walks.

**E. Empirically verified venue correctness.** `docs/WS_FIRST_MARKET_DATA.md` records a live route probe (2026-11-17): legacy `/ws/@aggTrade` silent, `/market/stream` streaming — the migration we derived from docs is already confirmed against the venue here, and `RestGuard` honors `-1003`/418/429/`Retry-After`/`banned until`.

**F. Evidence discipline that prevents self-deception.** `live-readiness.ts` promotes nothing without ≥100 trades/≥150 days + ≥50 paper/≥30 days and a positive 90% lower-bound net expectancy; the research plane is event-sourced (`ResearchEventBus`, champion/challenger state machine with `IllegalTransitionError`); event studies are pre-registered with Bonferroni/Holm correction and chronological holdouts. The log honestly states no family has an edge after costs yet. A new bot resets all of this to zero.

**G. Maturity and velocity.** ~2,591 agent tests + ~1,518 SDK tests, CI on Node 24, OIDC trusted publishing, ESLint/CodeQL pre-commit, 3,153 commits, active daily. LLM layers are advisory-only by construction (fail-closed parse, council detached from the tick loop, `LLM_COUNCIL_AUTOTRADE` refused, `TEV1_GATE` shadow-only).

**H. Owner-specific.** You wrote it; the `@nemesis-oss` SDK family is yours (MIT, freely reusable); the agent's proprietary license stays under your control. The only real gap is raw tick-level recording + tick-level book replay — a module, not a rewrite.

---

## 2. Configuring local-only execution

### Correction to my previous message

I previously said `npm run paper:core` runs in-memory with `PAPER_EXCHANGE_URL` unset. **That is wrong.** The `.env.example` states the paper-only core *"Requires PAPER_EXCHANGE_URL and PAPER_EXCHANGE_ACCOUNT_ID"*, and the architecture test proves the only `PaperExecutionPort` implementers are `PaperExchangeExecutionAdapter`/`PaperExchangeReplayAdapter` with `venue='paper_exchange'`. So `src/core` is **broker-backed**, not in-memory. There are two distinct local topologies:

| Topology                                     | Entry point                                               | Broker                                  | What it is                                                                                   |
|----------------------------------------------|-----------------------------------------------------------|-----------------------------------------|----------------------------------------------------------------------------------------------|
| **(a) Truly in-memory, zero extra services** | `src/index.tsx`, `MODE=paper`, `PAPER_EXCHANGE_URL` unset | none                                    | Legacy orchestrator + local `PaperEngine`. Fully self-contained.                             |
| **(b) Paper-only core + local broker**       | `npm run paper:core` (`src/core/main.ts`)                 | local `paper_exchange` Rails via docker | Clean-architecture core, structural live-order impossibility, but requires the local broker. |

**The `predev` gotcha:** `npm run dev:paper` triggers `predev:paper → predev`, which curls `${PAPER_EXCHANGE_URL:-http://127.0.0.1:3100}/up` and **auto-starts the docker broker if it is down**. So for topology (a) you must bypass the hook by invoking `tsx` directly:

```bash
# (a) pure in-memory local paper — no docker, no broker, no cloud
MODE=paper PAPER_EXCHANGE_URL= OLLAMA_HOST=http://127.0.0.1:11434 \
  npx tsx src/index.tsx
```

```bash
# (b) paper-only core against a LOCAL broker (still local-only, but needs docker)
cd "$PAPER_EXCHANGE_DIR" && docker compose up -d        # local Rails broker
PAPER_EXCHANGE_URL=http://127.0.0.1:3100 \
PAPER_EXCHANGE_ACCOUNT_ID=crypto-agent \
PAPER_EXCHANGE_API_KEY=<local operator token> \
  npm run paper:core
```

Both are local-only (no cloud, no live venue). Choose (a) for the simplest self-contained run; choose (b) when you want the test-enforced live-order boundary. `paper:core` has no `predev` hook, so you must start the broker yourself; `validatePaperOnlyConfig` refuses `MODE!=paper`.

### `.env` overrides for local-only

The shipped `.env.example` is **cloud-oriented** — it sets `OLLAMA_HOST=https://ollama.com` and `OLLAMA_MODEL=beam`. Copying it verbatim does *not* give you local Ollama. Override:

```dotenv
MODE=paper
# --- local Ollama (required override; .env.example ships cloud) ---
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4:31b            # a model you have actually pulled locally
OLLAMA_API_KEY_1=                  # leave cloud keys empty
LLM_COUNCIL=off                    # or on, but 5 personas + chair on one local model is heavy
TEV1_GATE=off                      # tev1 is a local fine-tune; off until benchmarked
PAPER_CORE_ADVISOR=off
# --- no live venue, no credentials needed for public market data ---
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_TESTNET=off
# --- topology (a): leave these unset; topology (b): set them to the local broker ---
# PAPER_EXCHANGE_URL=http://127.0.0.1:3100
# PAPER_EXCHANGE_ACCOUNT_ID=crypto-agent
# PAPER_EXCHANGE_API_KEY=
FLEET_ENTRIES=off                  # fleet is paper_exchange/cloud oriented
FLEET_IN_DEV=off
OPTIONS=off                        # simplify until futures paper is stable
# --- local ops / recording ---
AUDIT=on
EVENTS_PATH=data/events.jsonl
DECISIONS_PATH=data/decisions.jsonl
TELEGRAM_DRY_RUN=1                 # cards to cockpit log; nothing leaves the machine
MICRO_RECORD=on
MICRO_ENTRY_GATE=on
MICRO_RECORD_DIR=data/microstructure
SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
MAX_LEVERAGE=10
RISK_PER_TRADE_PCT=1
MAX_DRAWDOWN_PCT=5
```

Run a local daemon first: `ollama serve` and `ollama pull gemma4:31b`. JSON `format` mode is requested only against local hosts (the SDK refuses it on cloud), so local is the SDK's happy path. `RISK_ENGINE=off` is refused at startup — the deterministic risk engine always runs.

### Storage, secrets, verification

- **Storage:** everything is local `data/*.jsonl` (events, decisions, microstructure, paper-core journal/state/kill file). Add local DuckDB→Parquet compaction later; no S3.
- **Secrets:** `.env` is gitignored; use `age`/SOPS or the OS keychain; Gitleaks pre-commit. For any later testnet/live key use Ed25519, IP-whitelist it, and rely on `RiskGateway` denying withdrawals by default.
- **Verify before trusting it:**
  ```bash
  npm run check                 # typecheck + build + full test (incl. architecture boundary)
  npm run test:core             # the live-order impossibility tests specifically
  npx tsx scripts/record-market-data.ts --self-check 30   # streams actually arrive
  npm run backtest -- --symbol BTCUSDT --days 30          # replay parity
  ```

### Two honest local caveats (verified in your repo)

- **Geo/451:** `WS_FIRST_MARKET_DATA.md` records `fapi.binance.com` returning **HTTP 451** in your environment. Public WS streams work; futures REST backfill may be blocked. `KlineStreamCache` already falls back to WS-only and `RestGuard` refuses gracefully. For history, pull the free Vision S3 archives locally instead of `fapi`.
- **Latency:** a local machine's RTT to Binance Tokyo bounds the scalp tier. Intraday/swing are fine locally; do not represent local as HFT-grade. Also re-verify SBE before relying on it — your SDK's drift log quotes a spot CHANGELOG entry "SBE retirement" (2026-10-30).

---

## 3. Customizing the repo as its author/owner — do not fork

**Forking is the wrong tool for an owner.** A fork is for contributing to *someone else's* repository or for spinning a genuinely separate product. You own `shubhamtaywade82/crypto-trading-agent`; the correct workflow is **clone → branch → commit → PR to your own `main` → CI → merge**, using the guardrails already in the repo.

### Owner workflow

1. **Clone and install** (Node ≥ 24, npm ≥ 11 per `engines`):
   ```bash
   git clone git@github.com:shubhamtaywade82/crypto-trading-agent.git
   cd crypto-trading-agent && npm ci
   cp .env.example .env          # then apply the local-only overrides above
   ```
2. **Branch** (CI already triggers on `feat/**`, `feature/**`, `fix/**`, `develop`, `main`, and every PR):
   ```bash
   git checkout -b feat/raw-tick-recorder
   # optional parallel experiments without switching branches:
   git worktree add ../cta-experiment feat/raw-tick-recorder
   ```
3. **Customize inside the architecture, not around it.** The new recorder/replay code belongs in `src/core/adapters/binance` (SDK imports are permitted only in the adapters layer) or in a new `@nemesis-oss` workspace package. Preserve the closure rules the architecture test enforces: no `binance`/`coindcx` packages in core, no trading surfaces/credentials named in core, only the three permitted legacy modules reachable, strategies import only `domain`+`zod`. Add tests mirroring `core.architecture.test.ts` for any new seam.
4. **Bump and consolidate dependencies:** `@nemesis-oss/binance-sdk` 3.2.0 → 3.6.1; remove the duplicate `binance@^2.15.22` so there is one WS stack. Run `npm run check` and `npm run test:core`.
5. **PR to your own `main`.** The `ci.yml` `verify` job runs Node 24 `npm ci` → `typecheck` → `build` → `npm test` (the full suite includes the architecture boundary). Make that a required status check in branch protection; require review (even self-review) and disallow force-push to `main`.
6. **Use the research plane for strategy variation, not divergent forks.** `self-improve`, `ChampionRegistry`, and fold-based experiments are designed for controlled, event-sourced variation with rollback — that is your champion/challenger path, far safer than parallel forks drifting apart.
7. **Releases/versioning.** The agent has no releases yet; the SDK uses release-please + conventional commits + OIDC trusted publishing. If you version the agent (`bin: agent-trade`), adopt the same release-please pattern. Keep commits signed-off.
8. **Secrets hygiene throughout:** never commit `.env`; Gitleaks pre-commit + TruffleHog CI; rotate immediately on any exposure.

### Licensing — the one place a "fork" question is real

- The **agent is proprietary (AlgoScalperAPI)**. As owner you may do anything with it, but **do not push it to a public fork/repo** if it contains proprietary code — that would disclose it. Keep the agent private.
- The **SDK is MIT** and already public. Reusable primitives (raw-tick recorder, replay feed, fixed-point helpers) belong **in the SDK repo**, where they can be open and shared; the proprietary agent consumes them by version bump. This is the clean split: extend the MIT SDK for general capability, extend the private agent for your strategy.
- A **new repository** is justified only for a genuinely separate product with a different audience/license — and it should *depend on* the MIT SDK rather than fork the proprietary agent. That is not a fork of your agent; it is a new consumer of your SDK.

### When forking would actually apply

Only if you were contributing upstream to a repo you do **not** own, or deliberately creating a divergent product. Neither is your case. For an owner, branches + PRs + worktrees + monorepo workspaces (`apps/dashboard` already exists; add `packages/*`) give you isolation without the duplication and drift of a fork.

---

**Bottom line:** the existing repo's advantages are concrete and test-enforced — structural live-order impossibility in the paper core, hexagonal boundaries, deterministic replay parity, a mature SDK with fixed-point books and idempotent execution, verified venue routing, and an evidence-based promotion gate. For local-only, use topology (a) (`MODE=paper`, `PAPER_EXCHANGE_URL` unset, `tsx src/index.tsx` directly to bypass the `predev` docker hook) or topology (b) (`paper:core` against a *local* broker), and **override the cloud Ollama defaults** the shipped `.env.example` carries. And because you are the author, do not fork: clone, branch, PR into your own `main` behind the existing CI and architecture tests, keep the proprietary agent private, and put reusable primitives in the MIT SDK. The only substantial build left is the raw tick recorder and tick-level replay — a module on top of what already exists.
