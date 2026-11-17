# Fleet entry gate

Every entry the LLM fleet would place passes one gate first. Exits never do: a position must always be closable.

## What refuses an entry

| Gate | Source | Refuses when |
|---|---|---|
| Operator halt | `data/kill-switch.json`, the cockpit's kill switch, read at every decision | the halt is set, or the file is unreadable |
| Feed freshness | live trade ticks delivered to the worker | no tick has arrived yet, or the last one is over 15 s old |
| Circuit breaker | `MAX_DAILY_LOSS_PCT` (default 3), `MAX_LOSS_STREAK` (4), `MAX_DRAWDOWN_PCT` (5) | the state is HALTED or EMERGENCY |
| Account snapshot | venue equity from the last sync | none has been observed yet |

The circuit breaker is the repo's own `deriveCircuitState`. In CAUTION and REDUCED, entries are allowed with 75% and 50% of the per-trade risk budget. The margin cap is unchanged.

A refused entry sends no order. The worker's `lastDecision` reads `GOVERNOR REFUSED: <every reason>`.

## What is not gated

- **Exits**: stop-loss, take-profit, break-even and reduce-only closes. They are never refused.
- **The cockpit's full RiskEngine**: its exposure caps are percentages of equity. A 10x fleet position is roughly 980% of its $1,000 account, so that check would refuse every fleet entry.
- **Drawdown does not flatten.** The cockpit's `DRAWDOWN_BREACH_ACTION=flatten` default is not applied to the fleet. A breach only blocks new entries.

## State

`data/fleet-governor/<symbol>.json` holds the equity high-water mark, the UTC day's anchors, the day's realized PnL and the loss streak. It is written atomically.

- An unreadable file refuses entries and is left in place for inspection. The gate never overwrites it, because a rewrite would reset the high-water mark and the streak.
- Daily loss uses the worker's exit PnL, which is gross of fees. The venue's REALIZED_PNL ledger is the exact figure.
- The loss streak clears only on a winning exit. While the streak stands, entries are refused, so no winning exit can clear it. Clearing it is a deliberate operator act: delete that symbol's file. Whether it should reset automatically is an open policy question.

## Before arming: check the feed

```sh
npx tsx scripts/probe-usdm-routes.ts ETHUSDT 20
```

The probe reports which route streams each channel, against a control route that is known to stream. Its verdicts are withheld when the control is silent, because then the probe is blocked and the routes are untested.

## Running it 24/7

`deploy/systemd/fleet-remote.service` is a template. It does not set `FLEET_ENTRIES`, so entries stay off until you arm them.
