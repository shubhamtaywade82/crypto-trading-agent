# Directional experiments: step-by-step runbook

Runs the frozen experiments EXP-001 and EXP-002 on historical Binance USD-M data, and produces a report, a results file, and a manifest. Every step gives the command, what to expect, and how to check it.

**Read first**

- The engine returns NO_TRADE unless a cell passes the training gates and the holdout criterion. An honest result with `0 of N` publishable probabilities is a valid outcome.
- Do not edit `research/directional/*.json` after you have seen any result. To change a parameter, create a new experiment id.
- If `fapi.binance.com` or `data.binance.vision` returns HTTP 451 or 403 from your network, stop. That is a service-eligibility restriction. Do not route around it through another host.
- Nothing here places orders. The output is research evidence, not trading advice.

## What was verified, and what was not

| Step | Verified here | Note |
| --- | --- | --- |
| Install, `npm run check` | Yes | 2181 tests, typecheck, build |
| Database schema (`pit-migrate`) | Yes | Local PostgreSQL 16, same DDL |
| Funding read from `perp_funding_history` in the CLI | Yes | With synthetic rows |
| Experiment run, report, manifest | Yes | With synthetic minutes |
| Archive download and parse (`--fetch`) | Unit-tested | Against a generated zip. Not against the live archive |
| Universe seeding (`pit-seed-universe`) | No | Needs `fapi.binance.com` |
| Funding seeding (`pit-seed-funding`) | No | Needs `fapi.binance.com` |
| Real EXP-001 / EXP-002 results | No | Not run |

## 1. Prerequisites

| Need | Version or note |
| --- | --- |
| Node.js | 24 (CI uses 24; `package.json` requires `>=24`) |
| npm | 11 |
| git | any recent |
| PostgreSQL | 14 or later, via Docker or a local install. Step 4 covers both |
| Disk | a few GB free. The 1m cache is hundreds of MB per symbol for 22 months |
| RAM | not measured at this size. If the run is killed, rerun with `NODE_OPTIONS=--max-old-space-size=8192` |
| Network | access to `fapi.binance.com` and `data.binance.vision` from your location |

## 2. Get the code at the frozen commit

```bash
git clone https://github.com/shubhamtaywade82/crypto-trading-agent.git
cd crypto-trading-agent
git fetch origin claude/liquidity-rejection-zones-yd5f9y
git checkout claude/liquidity-rejection-zones-yd5f9y
git log --oneline -n 3
node --version
```

Expect the branch head to include `directional` commits, and Node `v24.x`.

## 3. Install and verify the code

```bash
npm ci
npm run check
```

Expect the last lines to report `# fail 0`. The count is 2181 at this commit.

## 4. Start PostgreSQL

The scripts default to port 5434, so the commands below use that port. Pick one option.

**Option A, Docker**

```bash
docker run -d --name supervisor-pg \
  -e POSTGRES_USER=supervisor -e POSTGRES_PASSWORD=supervisor -e POSTGRES_DB=supervisor \
  -p 5434:5432 postgres:16
docker exec supervisor-pg pg_isready -U supervisor
```

Expect `accepting connections`.

**Option B, local install (Debian/Ubuntu)**

```bash
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE ROLE supervisor LOGIN PASSWORD 'supervisor';"
sudo -u postgres createdb -O supervisor supervisor
```

Then use port 5432 in the next step.

Set the connection string for the rest of the session. Use port 5432 for option B:

```bash
export PIT_DATABASE_URL=postgres://supervisor:supervisor@localhost:5434/supervisor
```

## 5. Create the schema

```bash
npx tsx scripts/pit-migrate.ts
```

Expect `Schema applied` and four tables: `perp_contract_lifecycle`, `perp_funding_history`, `perp_market_bars`, `perp_margin_tiers`.

Check:

```bash
psql "$PIT_DATABASE_URL" -c '\dt perp_*'
```

## 6. Seed the contract universe (Binance API)

```bash
npx tsx scripts/pit-seed-universe.ts
psql "$PIT_DATABASE_URL" -c "SELECT symbol, status, listed_at FROM perp_contract_lifecycle WHERE symbol IN ('SOLUSDT','ETHUSDT','XRPUSDT','BTCUSDT');"
```

Expect one row per symbol with `status` `ACTIVE`. If a symbol is missing, the experiment excludes it, and the report says so.

## 7. Seed funding history (Binance API)

```bash
npx tsx scripts/pit-seed-funding.ts --symbols SOLUSDT,ETHUSDT,XRPUSDT,BTCUSDT
```

Check the coverage before running any experiment:

```bash
psql "$PIT_DATABASE_URL" -c "SELECT symbol, count(*) AS settlements, min(funding_time) AS first, max(funding_time) AS last FROM perp_funding_history GROUP BY symbol ORDER BY symbol;"
psql "$PIT_DATABASE_URL" -c "SELECT symbol, max(gap) AS max_gap FROM (SELECT symbol, funding_time - lag(funding_time) OVER (PARTITION BY symbol ORDER BY funding_time) AS gap FROM perp_funding_history) g WHERE gap IS NOT NULL GROUP BY symbol;"
```

Expect about three settlements per day, and a `max_gap` of `08:00:00` or less. For the 2025-01-01 window, `first` should be on or before 2025-01-01 08:00 UTC. A setup whose horizon spans a gap longer than 8 hours cannot be priced. When that happens, the symbol is excluded with `FUNDING_COVERAGE` in the report, and the reason names the gap.

## 8. Review the frozen configs

```bash
cat research/directional/exp-001.json
cat research/directional/exp-002.json
git status --short
```

Check the costs. `feeBpsPerSide: 4` and `slippageBpsPerSide: 2` match `DEFAULT_OUTCOME_POLICY` in `src/playbooks/outcome.ts`. If your fee tier differs, change the config now, before any run, and commit the change. `git status --short` should print nothing.

Record the commit you are running on:

```bash
git rev-parse HEAD
```

## 9. Pilot one symbol and one month (recommended)

This checks the archive format, the timing, and the funding join on a small window. Its cache goes to its own directory, so it cannot be mistaken for the full cache.

```bash
mkdir -p data/pilot
python3 - <<'EOF'
import json
cfg = json.load(open('research/directional/exp-001.json'))
cfg['experiment'] = 'PILOT-EXP-001'
cfg['symbols'] = ['SOLUSDT']
cfg['window'] = {'from': '2026-09-01', 'to': '2026-10-01'}
json.dump(cfg, open('data/pilot/pilot.json', 'w'), indent=2)
print('wrote data/pilot/pilot.json')
EOF
npx tsx scripts/directional-experiment.ts --config data/pilot/pilot.json --fetch \
  --data-dir data/pilot/flow-klines --out data/pilot/out
```

Expect `SOLUSDT: fetched … minutes from … archive file(s)`, then `wrote …`. The result is not admissible: a one-month window has too few days for the holdout. The pilot is for checking the pipeline.

Before the pilot, check one raw archive file yourself. The loader expects twelve columns with millisecond timestamps, and refuses anything else:

```bash
curl -sSL https://data.binance.vision/data/futures/um/monthly/klines/SOLUSDT/1m/SOLUSDT-1m-2026-09.zip -o /tmp/sol-2026-09.zip
python3 -c "import zipfile,sys; z=zipfile.ZipFile('/tmp/sol-2026-09.zip'); print(z.read(z.namelist()[0]).decode()[:300])"
```

Expect rows like `1788220800000,…` with 12 comma-separated fields. If the first field is in microseconds, or the layout differs, stop and report it. The loader is not designed for that format.

## 10. Full run, EXP-001

```bash
NODE_OPTIONS=--max-old-space-size=8192 \
npx tsx scripts/directional-experiment.ts --config research/directional/exp-001.json --fetch
```

The first run downloads the 1m archive for each symbol and writes `data/flow-klines/<SYMBOL>-1m.jsonl`. It then reads funding from the database and runs the experiment. Runtime at this size has not been measured.

Later runs can skip the download:

```bash
npx tsx scripts/directional-experiment.ts --config research/directional/exp-001.json
```

Without `--fetch`, a missing cache stops the run with `missing … rerun with --fetch`.

## 11. Full run, EXP-002

```bash
NODE_OPTIONS=--max-old-space-size=8192 \
npx tsx scripts/directional-experiment.ts --config research/directional/exp-002.json --fetch
```

EXP-002 reuses the same cache, so `--fetch` is not needed again. Add it only if you have deleted the cache.

## 12. Read the output

Each run writes to `data/directional/<EXPERIMENT>/<UTC timestamp>/`:

| File | Contents |
| --- | --- |
| `REPORT.md` | Symbols, excluded symbols with reasons, cells, reasons cells did not pass, scale-out comparison |
| `results.json` | Every cell and symbol summary, with all numbers |
| `manifest.json` | Git commit, `workingTreeClean`, config SHA-256, criterion id, input counts, excluded symbols |

Start with `REPORT.md`:

```bash
OUT=$(ls -d data/directional/EXP-001/*/ | tail -1)
cat "$OUT/REPORT.md"
python3 -m json.tool "$OUT/manifest.json" | head -30
```

Check these, in this order:

1. **Excluded symbols.** Any `GAPS`, `FUNDING_COVERAGE`, or `REJECTED_KLINES` reason means that symbol's data needs attention before you rely on the result.
2. **Manifest.** `workingTreeClean` must be `true`, and `gitHead` must be the commit you recorded in step 8.
3. **Publishable count.** The line `Cells with a publishable probability: K of N` is the headline. A cell is publishable only if it is `admitted: yes` and `holdout accepted: yes` under `HOLDOUT_V1`.
4. **Calibration.** For each tagged cell, `gap` is the holdout hit rate minus the training hit rate. The criterion allows at most 0.05 in absolute value. The training estimate must also lie inside the holdout interval.
5. **Target separation.** For the same context, hit rates should fall as the target grows. A larger target whose hit rate is high but whose holdout is not calibrated is the inflation the review warned about. The success criterion from the review is to separate small moves from large ones without inflating the large ones.
6. **Scale-out.** The paired difference is ladder minus single target, in R. Its interval is clustered by day. An interval that spans zero is not evidence for either policy.

## 13. Reproduce a result

Runs on the same cache, config, and commit should produce the same numbers. The bootstrap uses a fixed seed. To check:

```bash
npx tsx scripts/directional-experiment.ts --config research/directional/exp-001.json --out data/rerun
diff "$(ls -d data/directional/EXP-001/*/ | tail -1)REPORT.md" "$(ls -d data/rerun/EXP-001/*/ | tail -1)REPORT.md"
```

Expect no output from `diff`. The timestamped folders differ, but the report should not.

## 14. Troubleshooting

| Message | Meaning | Action |
| --- | --- | --- |
| `HTTP 451` from the API or archive | Service restriction at your location | Stop. Do not route around it |
| `ARCHIVE_HTTP 404: …` | That month or day is not published | Shorten the window to published days |
| `ARCHIVE_UNAVAILABLE: … not yet published` | The window ends too close to today | Set `window.to` earlier |
| `missing data/flow-klines/…` | No cache, and `--fetch` was not given | Run once with `--fetch` |
| Symbol in `excluded` with `GAPS` | The 1m series has missing minutes in the window | Re-fetch, or accept the exclusion |
| Symbol in `excluded` with `FUNDING_COVERAGE` | Settlements are missing or too sparse | Re-run step 7, then check the coverage queries |
| `ECONNREFUSED` on the database | PostgreSQL is not running, or the port is wrong | Check `PIT_DATABASE_URL`; run step 4 again |
| Process killed (out of memory) | The 1m data is large | Use `NODE_OPTIONS=--max-old-space-size=8192`, or run one symbol per config |

## 15. What this runbook does not cover

- **EXP-003** (higher-timeframe breakout, retest, and sustained expansion). Breakout and retest detection is not implemented, so there is no config for it.
- **BTC and derivatives context.** Not built. The four symbols are tested independently, with no BTC conditioning.
- **Absorption as its own cell.** EXP-002 uses the volatility-expansion context at entry. The absorbed-versus-not split is not a separate tagged cell in this version.
- **Correction across experiments.** Holm applies within one table. Comparing EXP-001 and EXP-002 needs a correction across both, which is not set up.
- **The criterion values.** `HOLDOUT_V1` was chosen before any historical run, but it is not a timestamped pre-registration. Record the values, and the commit that introduced them, before you publish any result.
