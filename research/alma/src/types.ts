export const NATIVE_TIMEFRAMES = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
] as const;

export type NativeTimeframe = (typeof NATIVE_TIMEFRAMES)[number];

export type AlmaSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

export const ALMA_SOURCES: readonly AlmaSource[] = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'];

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AlmaParams {
  length: number;
  offset: number;
  sigma: number;
}

export interface DatasetManifest {
  schemaVersion: 1;
  symbol: string;
  venue: 'BINANCE_USDM_PERPETUAL';
  marketDataType: 'CONTRACT_KLINES';
  timeframe: NativeTimeframe;
  sdkPackage: '@nemesis-oss/binance-sdk';
  sdkVersion: string;
  retrievedAt: string;
  requestedStartTime: number;
  requestedEndTime: number;
  firstOpenTime: number;
  lastOpenTime: number;
  candleCount: number;
  sha256: string;
  validation: {
    valid: boolean;
    issueCount: number;
    gapCount: number;
    duplicateCount: number;
  };
}