# Data contract

## Instrument and source

- Venue: Binance USDⓈ-M Futures.
- Symbol: SOLUSDT.
- Source: public REST market data through @nemesis-oss/binance-sdk.
- SDK surface: client.futures.market.klines(symbol, interval, params).
- No credentials or authenticated endpoints are required for this dataset.

Spot candles must not be mixed with USDⓈ-M perpetual candles. Mark-price, index-price and contract-price klines are distinct datasets and must use different source identifiers. The baseline research uses contract klines; mark-price data may be added as a separate, explicitly versioned dataset for liquidation-aware execution assumptions.

## Canonical candle

All timestamps are UTC epoch milliseconds. The normalized record contains:

~~~ts
interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
~~~

Prices and volumes are stored as numbers in analysis files, but source payloads should be retained without lossy re-rounding if the SDK exposes decimal strings. Do not use display-formatted chart values as historical inputs.

## Fail-closed validation

A dataset is rejected if any of these conditions fail:

- Empty data or non-finite timestamp/OHLCV values.
- Non-positive OHLC prices, negative volume, or an OHLC envelope violation: low <= open/close <= high and low <= high.
- Duplicate open timestamps.
- Non-monotonic candle ordering.
- Unexpected candle cadence or gaps within the claimed collection window.
- A candle is still forming at collection time.
- A retrieved interval differs from the requested interval or a page does not advance.

The validator reports the first failing rows and summary counts. It does not silently sort rows, drop conflicting duplicates, fill gaps, or repair OHLC data. Missing bars must be investigated before the dataset is admitted to an experiment.

For the monthly interval (1M), expected next open time is the first UTC day of the next month; do not treat months as a fixed number of milliseconds.

## Dataset file and manifest

Raw files go to data/research/alma/raw/<SYMBOL>-<INTERVAL>.json. Each file must have a companion manifest with:

- symbol, venue, interval, requested start/end, actual first/last open time;
- retrieval timestamp and SDK package version;
- number of bars and quality-validation summary;
- SHA-256 checksum of the exact serialized candle file.

Generated events, features, candidate tables, and performance reports are separate derived artifacts; never overwrite raw files in place. Re-fetches create new snapshots or require an explicit force flag.

## Multi-timeframe alignment

At a decision timestamp T, a candle is available only if its close time is strictly earlier than or equal to T and its final OHLC is known. For example, a 15m decision at 10:15 UTC cannot read the 1h candle that closes at 11:00 UTC. MTF alignment must use as-of joins on close timestamps, not nearest timestamp joins that can leak future bars.

## Reproducibility

- Store UTC timestamps and keep exchange timezone out of strategy logic.
- Store raw dataset checksums and config hashes.
- Compare candle count to the expected count over each interval's actual coverage, not over a range truncated by the exchange's listing date.
- Record the fetched-at time and exclude the still-open candle.
- Do not mix data windows without reporting the common intersection used for an MTF experiment.