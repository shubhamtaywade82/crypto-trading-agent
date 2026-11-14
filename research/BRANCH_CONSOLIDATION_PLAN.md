# Research branch consolidation plan

**Target:** `research/umbrella`  
**Created from:** `main` at `7b4be7c90777d865e9f82de86159070098a54933`  
**Status:** target branch created; source merges not yet executed; no source branches deleted.

## Why a bulk merge is unsafe

The repository contains many timestamped `research/context-strategy-*` and `research/raw-ohlcv-archive-*` branches, plus an existing `research/consolidated`, `research/registry-snapshots` and `feat/crypto-research-factory-design`.

The branches are not a set of independent feature branches:

- `research/context-strategy-20261113T2245Z-v112` compares to `main` as **906 ahead / 341 behind**.
- `research/raw-ohlcv-archive-20261113T2245Z-auto11` compares to `main` as **2,220 ahead / 1,607 behind**.
- `research/registry-snapshots` compares to `main` as **2 ahead / 310 behind**.
- `feat/crypto-research-factory-design` compares to `main` as **12 ahead / 545 behind**.
- Context-strategy run branches are successive snapshots; for example, v112 is 19 commits ahead of v111. Merging every historical run branch would reintroduce superseded artifacts and duplicate history.

The compare API reports at most 300 changed files for these large histories. That is not a complete file-level conflict audit. A direct merge of all branch refs would therefore be an uncontrolled integration, not a safe consolidation.

## Integration policy

1. Keep `research/umbrella` as the integration target and preserve every source branch.
2. Group source refs by family: context strategy, raw OHLCV archive, registry snapshots, research-factory design, and any existing consolidated branch.
3. Within each family, identify the latest non-ancestor tip. Treat earlier timestamped runs as lineage/evidence, not automatically as merge candidates.
4. Review commit ancestry and complete changed-file inventories. Classify each delta as code, schema, raw data, manifest, experiment result, registry, queue or obsolete snapshot.
5. Integrate one family at a time. Prefer PRs or explicit merge commits with conflict review and tests; keep large raw archives in a dedicated data branch or artifact store rather than mixing them indiscriminately into application code.
6. After each integration, verify the source SHA, resulting tree, tests, archive manifests and registry lineage.
7. Do not delete or force-move source refs until the target is verified and a human explicitly authorizes cleanup.

## Current run

The following run artifacts have been committed to `research/umbrella` and reference the dedicated raw archive branch:

- `research/context-strategy/reports/context_strategy_20261114T053039Z_auto11_run16.md`
- `research/context-strategy/runs/20261114T053039Z_auto11_run16/preflight.json`
- `research/context-strategy/runs/20261114T053039Z_auto11_run16/run-manifest.json`
- `research-data/binance-usdm/research-queue-v132.json`
- `research-data/binance-usdm/conditional-strategy-registry-snapshot-v132.json`

The active raw archive branch for this run is `research/raw-ohlcv-archive-20261108T1026Z`. It contains the verified 5m/15m incremental delta, page-0026/page-0027 audits, current snapshot, archive manifest v122 and updated interval indexes.

**No source research branch has been merged into `research/umbrella` yet.** The next safe step is to choose and review one latest tip per family, then integrate sequentially.
