# Imported SOLUSDT research artifacts

This directory consolidates additional research files found in the ChatGPT Library on 2026-11-04.

## Imported in this commit
- `alma_solusdt_backtest.py`: reproducible ALMA/EMA and pullback backtest harness; expects externally supplied closed-candle CSVs.
- `reports/solusdt_smc_ict_backtest_report.md`: exploratory SMC/ICT historical backtest report. Its own conclusion is that no setup is approved for live trading.
- `strategies/SMC-CE-v6.0-Decision-Execution.pine`: Pine Script strategy source retained as research material, not a validated production strategy.
- `reports/SOLUSDT_Binance_Historical_Research_Report.md`: text extraction of the Library PDF report dated 2026-10-12. The duplicate DOCX and original PDF were not copied as binary files in this commit.

## Existing branch research assets
The branch already contains the v55 registry snapshot and latest pointer, market snapshots, research queue, ALMA research implementation/protocol/tests, experiment specifications/results, and Binance USDⓈ-M raw archive pages/manifests under `research/`.

## Evidence and deployment status
These imported artifacts are historical research inputs. Their presence in Git does not imply independent reproduction, data-source revalidation, or strategy approval. The latest v55 registry remains classified `RESEARCH_BLOCKED`; it records zero new experiments, zero OOS evaluations, and zero OOS-validated strategies for that run.

## Source handling
- Duplicate ALMA script copy `alma_solusdt_backtest(1).py` was not duplicated.
- Duplicate SOLUSDT report DOCX was not copied separately; the report is represented as Markdown text extracted from the PDF.
- Unrelated Indian index-options project logs, dashboard mockup images, and non-research design assets were excluded.
