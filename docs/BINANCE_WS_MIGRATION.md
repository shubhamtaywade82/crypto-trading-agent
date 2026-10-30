# Live Binance connectivity after the 2026-04-23 WebSocket migration

This note records what changed in this repository's live (MODE=live) Binance USDⓈ-M connectivity and
why, what was verified against Binance's official contract, and what remains open — including the
file-specific remediation task for the `binance-sdk` dependency, which cannot be fixed from this
repository.

## The contract (verified, official)

Binance's **"Important WebSocket Change Notice — Base URL Split & Migration"** (developers.binance.com,
USDⓈ-M futures → Websocket Market Streams) split the futures WebSocket gateway into routes:

| Route | Purpose | ws mode (path) | stream mode (query) |
| --- | --- | --- | --- |
| `/public` | high-frequency data: `bookTicker`, `!bookTicker`, `depth*` | `wss://fstream.binance.com/public/ws/bnbusdt@depth/ethusdt@depth` | `…/public/stream?streams=…` |
| `/market` | regular market data: `aggTrade`, `markPrice`, `kline_*`, `ticker`, `trade`, … | `wss://fstream.binance.com/market/ws/btcusdt@aggTrade/ethusdt@aggTrade` | `…/market/stream?streams=…` |
| `/private` | user data | `wss://fstream.binance.com/private/ws?listenKey=<k>&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE` | `…/private/stream?listenKey=<k1>&events=…&listenKey=<k2>&events=…` |

Key facts from the notice, all honored by the code:

- **Legacy URLs were permanently decommissioned on 2026-04-23.** After that date an un-migrated
  connection receives *only* the public channels: `wss://fstream.binance.com/ws/btcusdt@depth`
  still worked, but `wss://fstream.binance.com/ws/btcusdt@markPrice` did not.
- The listen key is a **query parameter** on the private route. The path forms `/private/ws/<listenKey>`
  and the pre-migration `/ws/<listenKey>` are wrong.
- `events` accepts **multiple event names** (slash-separated in ws mode) and the private route
  accepts **multiple listen keys** (stream mode).
- A JSON `SUBSCRIBE` may carry market/public stream names and listen-key event items together.
- Connections are **cut at the 24-hour mark**; the server pings every 3 minutes and drops a client
  that has not answered within 10 minutes.
- The **listen-key REST contract is unchanged**: `POST`/`PUT`/`DELETE /fapi/v1/listenKey`, and a key
  stays valid for 60 minutes after creation/keepalive.

## What was broken here

Both WebSocket paths this repository's live mode used were dead after 2026-04-23:

1. **Market data**: the `binance` npm package (v2.15.22) dials `wss://fstream.binance.com/ws/<symbol>@trade`.
   `trade` is a *market* route channel, so the feed received nothing.
2. **User data**: the same package's `subscribeUsdFuturesUserDataStream()` dials
   `wss://fstream.binance.com/ws/<listenKey>` — the retired private path, so entry-fill wakeups
   never arrived and the stream silently provided no value (entries fell back to 1-second REST
   polling, which is why live trading kept working at all).

Additionally, three call sites used the **deprecated v2 account REST** (`getAccountInformation()` →
`GET /fapi/v2/account`).

## What changed

| File | Change |
| --- | --- |
| `src/binance/wsRoutes.ts` (new) | The route table above as code: per-environment bases (live/testnet), `buildMarketStreamUrl`, `buildPrivateStreamUrl` (query-parameter listen key, safe encoding that keeps the documented `@` and `/` literals), `maskListenKey` for logs. |
| `src/binance/userDataStream.ts` (new) | The private user-data stream lifecycle: states `STOPPED → STARTING → CONNECTING → CONNECTED → RENEWING → RECONNECTING`, listen-key create/keepalive/release over the unchanged REST contract, 30-minute keepalive (60-minute validity), `listenKeyExpired` and 3× keepalive failure → fresh key + reconnect, bounded exponential backoff with jitter, a generation counter so retired sockets cannot corrupt state, unknown-event tolerance (reported, never fatal), and no raw listen key in any log line. |
| `src/binance/client.ts` | Market WS now dials the `/market` base (the package appends `/ws/<stream>` itself). `startUserStream()` drives `UserDataStream` instead of the package's retired URL builder; `ORDER_TRADE_UPDATE` wakes the entry tracker, `MARGIN_CALL` is surfaced at error level. New `userStreamStatus()` exposes stream health. All three `getAccountInformation()` call sites migrated to `getAccountInformationV3()` (`GET /fapi/v3/account`); positions already used `getPositionsV3()` (`GET /fapi/v3/positionRisk`). |
| `scripts/binance-testnet-verify.ts` | Account check moved to V3 and a new V3 balance check (`getBalanceV3()` → `GET /fapi/v3/balance`) added; the startup-path check now also asserts the user-data stream reaches `CONNECTED`. |
| `tests/wsRoutes.test.ts`, `tests/userDataStream.test.ts` (new) | 23 tests: URL construction (both environments), encoding, missing-key refusal, legacy-path regression guards, cross-product isolation, and the full stream lifecycle against a scripted socket. |
| `tests/liveVenue.test.ts` | The fake venue speaks `getAccountInformationV3` (the surface the production code now calls). |

### Design decisions worth recording

- **The stream is an accelerator, not a source of truth.** The entry tracker reconciles order state
  by REST polling every second (by client order id; `-2013` → never placed), the journal rebuilds
  from trade-id cursors, and startup reconciliation re-plans from the venue's open orders and
  positions. A user-data stream outage therefore degrades reaction latency, never correctness —
  which is also why a stream outage does **not** block entries (the REST freshness gates in
  `entryBlockReason` do). This is the pre-existing, deliberate design; the fix restores the stream
  without changing that contract.
- **Node's global `WebSocket`** (stable since Node 22; this repo requires >= 24) is used for the
  private stream — no new dependency — behind a tiny injectable socket factory so tests are
  deterministic and no test ever opens a network socket.
- **Testnet routing is unverified.** Binance's notice documents no routed paths for
  `fstream.binancefuture.com`. `usdmWsRouteBases('testnet')` keeps Binance's documented testnet host
  with the same route suffixes and flags them `unverifiedRouting: true`; the bases accept explicit
  overrides so a documented testnet endpoint can be pinned the day Binance publishes one.
  `npm run verify:testnet` is the tool that will prove or disprove it.

## Open item: the `binance-sdk` dependency (v3.5.1 task list)

`@nemesis-oss/binance-sdk` 3.5.0 (the newest published) still routes its USDⓈ-M user stream through
`wss://fstream.binance.com/public/ws` (its `resolveEnvironment` derives `wsUserHost` from the
`/public/ws` legacy path) — the exact defect class fixed here. The SDK repository is not available
from this repository, so the remediation is recorded as a task for the SDK, mirroring the agent-side
fix:

1. `src/client/endpoints.ts` — split `wsPublic` / `wsMarket` / `wsPrivate` / `wsApi` / `rest` per
   environment (live, testnet, demo); live values per the table above; testnet/demo routed paths are
   **unverified until Binance documents them** — do not copy live URLs blindly.
2. Private stream builder — `wss://fstream.binance.com/private/ws?listenKey=<key>&events=A/B`
   (query, URL-encoded, `@`/`/` literals preserved), never `/private/ws/<key>`; `events` multi-value
   only per the verified contract; credentials never in logs.
3. Keep the listen-key REST (`/fapi/v1/listenKey`) as the key lifecycle; `session.logon` on the WS
   API is a separate concern and must not be treated as a listen-key substitute.
4. Order response schemas — keep ACK/RESULT/query/modify/cancel and `ORDER_TRADE_UPDATE` contracts
   separate; model `avgPrice`, `executedQty`, `cumQuote`, `updateTime` as optional; never default a
   missing executed quantity to `'0'` (missing means unknown).
5. Reconnect policy — read-only RPC may retry within a bounded policy; order writes must never be
   replayed blind after reconnect; surface `UNKNOWN_OUTCOME` (request id, method, client order id)
   and reconcile before any resubmission.
6. Regression tests mirroring `tests/wsRoutes.test.ts` (both environments, encoding, no-legacy-path
   guards, cross-product isolation: COIN-M `/dapi` untouched).

Once published as 3.5.1, this repository can adopt the SDK's stream and retire
`src/binance/userDataStream.ts` in favor of it — the integration point is exactly
`BinanceService.startUserStream()`.

## Verification

- `npm run typecheck`, `npm run build`: clean.
- `npm test`: 1986 passing (1963 baseline + 23 new).
- Live/testnet behaviour: run `npm run verify:testnet` (BINANCE_TESTNET=on credentials required);
  it now asserts the private stream reaches `CONNECTED` over the new route and that `/fapi/v3/balance`
  answers. No live orders are placed by any test.
