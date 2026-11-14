# Archive manifest predecessor-hash audit — 2026-11-14 08:04 UTC

- v126 path: research-data/binance-usdm/manifests/archive_manifest_20261114T0730Z_auto11_v126.json
- v126 Git blob SHA-1: e56720ad78f5bb92be5d19a84c67f59aecde890b
- v126 verified UTF-8 SHA-256: d87b417d782777971f1277f19c9c7dd148cbe13d8221734fa4952c0a4671e3c7
- v127 path: research-data/binance-usdm/manifests/archive_manifest_20261114T0758Z_auto11_v127.json
- v127 verified UTF-8 SHA-256: 071f276ed39c387a07cacf8c08ce05a7f27d6e07442201012a214ca3e94b7b1e
- v127 Git blob SHA-1: 503e0ce0e953e0488615d05ab10bc630bbbb8279
- Defect: v127.previous_archive_manifest.sha256 currently equals the v126 Git blob SHA-1, not the v126 UTF-8 SHA-256.
- Impact: v127's own content hash, delta SHA-256, delta manifest SHA-256, index readback and raw delta bytes remain verified. Only predecessor-chain metadata is mislabeled.
- Remediation: correct the predecessor SHA-256 field, recompute v127 SHA-256, update 5m/15m archive-index manifest SHA references, and regenerate the archive readback receipt. Do not rewrite raw delta JSONL.