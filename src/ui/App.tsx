import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Orchestrator } from '../runtime/Orchestrator.js';
import { useStore } from '../store.js';
import { clampSelection, MIN_COLS, MIN_ROWS, renderCockpit, ResizeWarning } from './panels.js';
import { renderMtfScreen } from './mtfPanels.js';
import { formatLocalTime, type CurrencyMode } from './format.js';
import { getSymbolRules, roundPrice } from '../binance/symbolRules.js';
import { config } from '../config.js';
import type { MarketPriceInfo } from '../types.js';
import type { NativeTimeframe } from '../market/MarketDataTypes.js';

const TIMEFRAMES: NativeTimeframe[] = ['5m', '15m', '1h', '4h'];

export function nextLerpPrice(sym: string, curr: number, target: number, tickSize: number): number {
  const diff = target - curr;
  if (Math.abs(diff) <= tickSize) return target;
  const step = diff * 0.35;
  const clamped = Math.abs(step) < tickSize ? Math.sign(diff) * tickSize : step;
  return roundPrice(sym, curr + clamped);
}

export function updatePrices(
  prev: Record<string, MarketPriceInfo>,
  targets: Record<string, MarketPriceInfo>,
  flashes: Record<string, number>,
  now: number,
): Record<string, MarketPriceInfo> | null {
  let changed = false;
  const next: Record<string, MarketPriceInfo> = { ...prev };
  for (const [sym, target] of Object.entries(targets)) {
    if (!target) continue;
    if (!prev[sym]) {
      next[sym] = target;
      changed = true;
      continue;
    }
    const curr = prev[sym];
    const diff = target.price - curr.price;
    if (diff !== 0) {
      const { tickSize } = getSymbolRules(sym);
      flashes[sym] = now;
      const price = nextLerpPrice(sym, curr.price, target.price, tickSize);
      next[sym] = { ...target, price, tickDirection: diff > 0 ? 'UP' : 'DOWN' };
      changed = true;
    } else if (curr.tickDirection && now - (flashes[sym] ?? 0) > 250) {
      next[sym] = { ...curr, tickDirection: undefined };
      changed = true;
    }
  }
  return changed ? next : null;
}

function useLerpPrices(targetPrices: Record<string, MarketPriceInfo> | undefined): Record<string, MarketPriceInfo> | undefined {
  const [displayed, setDisplayed] = useState(targetPrices);
  const flashes = useRef<Record<string, number>>({});
  const targetsRef = useRef(targetPrices);
  targetsRef.current = targetPrices;

  useEffect(() => {
    // Fixed 20 FPS ticker steps smoothly towards current targets and decays color flashes
    const timer = setInterval(() => {
      if (!targetsRef.current) return;
      setDisplayed((prev) => updatePrices(prev ?? {}, targetsRef.current!, flashes.current, Date.now()) ?? prev);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  return displayed;
}

export default function App() {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({
    cols: stdout?.columns ?? process.stdout.columns ?? 128,
    rows: stdout?.rows ?? process.stdout.rows ?? 58,
  }));

  useEffect(() => {
    const handleResize = () => {
      // Clear viewport to prevent ghost borders when narrowing the terminal
      process.stdout.write('\x1b[2J\x1b[H');
      setTerminalSize({
        cols: process.stdout.columns || 128,
        rows: process.stdout.rows || 58,
      });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  const [orchestrator] = useState(() => new Orchestrator());
  const [isSyncing, setIsSyncing] = useState(false);
  const [time, setTime] = useState(() => new Date().toISOString().slice(11, 19));
  const [localTime, setLocalTime] = useState(() => formatLocalTime());
  const [selPos, setSelPos] = useState(0);
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode>(() => (Boolean(config.coindcx?.apiKey) ? 'BOTH' : 'USD'));
  const [view, setView] = useState<'cockpit' | 'mtf'>('cockpit');
  const [mtfPairIndex, setMtfPairIndex] = useState(0);
  const [mtfTimeframe, setMtfTimeframe] = useState<NativeTimeframe>('15m');

  const state = useStore();
  const lerpPrices = useLerpPrices(state.spotPrices);
  const { positions } = state;
  const set = useStore((s) => s.set);
  const pushLog = useStore((s) => s.pushLog);
  // One clamped value drives the key handler, the highlight and the action list, so 'c' always closes the row shown as selected
  const selectedIndex = clampSelection(selPos, positions.length);
  const selectedPosition = positions[selectedIndex];

  useEffect(() => {
    setSelPos((s) => clampSelection(s, positions.length));
  }, [positions.length]);

  useEffect(() => {
    orchestrator.on('state', (state) => set(state));
    orchestrator.on('log', (entry) => pushLog(entry));
    orchestrator.on('sync', (syncing: boolean) => setIsSyncing(syncing));
    orchestrator.start();

    const clockTimer = setInterval(() => {
      const now = new Date();
      setTime(now.toISOString().slice(11, 19));
      setLocalTime(formatLocalTime(now));
    }, 1000);

    // Issue #5: synchronously flush the local PaperEngine's debounced state
    // on SIGINT/SIGTERM before the process exits, so the 250ms debounce
    // timer can't drop the last state.
    const flush = () => orchestrator.flushOnShutdown();
    process.on('SIGINT', flush);
    process.on('SIGTERM', flush);

    return () => {
      orchestrator.stop();
      clearInterval(clockTimer);
      process.off('SIGINT', flush);
      process.off('SIGTERM', flush);
    };
  }, [orchestrator, set, pushLog]);

  useInput((input, key) => {
    if (key.tab || input === 'm') {
      setView((v) => (v === 'cockpit' ? 'mtf' : 'cockpit'));
      return;
    }
    if (view === 'mtf') {
      const symList = config.symbols;
      if (key.upArrow) setMtfPairIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) setMtfPairIndex((i) => Math.min(symList.length - 1, i + 1));
      if (key.leftArrow) {
        setMtfTimeframe((tf) => {
          const idx = TIMEFRAMES.indexOf(tf);
          return TIMEFRAMES[(idx - 1 + TIMEFRAMES.length) % TIMEFRAMES.length];
        });
      }
      if (key.rightArrow) {
        setMtfTimeframe((tf) => {
          const idx = TIMEFRAMES.indexOf(tf);
          return TIMEFRAMES[(idx + 1) % TIMEFRAMES.length];
        });
      }
    } else {
      if (key.upArrow) setSelPos(clampSelection(selectedIndex - 1, positions.length));
      if (key.downArrow) setSelPos(clampSelection(selectedIndex + 1, positions.length));
    }
    if (input === 'c' && selectedPosition) orchestrator.closePosition(selectedPosition);
    if (input === 'x') orchestrator.cancelAll();
    if (input === 'k') orchestrator.toggleKillSwitch();
    if (input === 'u') setCurrencyMode((m) => (m === 'USD' ? 'INR' : m === 'INR' ? 'BOTH' : 'USD'));
    if (input === 'a' || input === 'i') orchestrator.askAdvisor();
    if (input === '?') {
      pushLog({
        ts: Date.now(),
        agent: 'SYSTEM',
        msg: 'COMMANDS: Tab/m toggle view │ ↑↓ select │ u currency (USD/INR/BOTH) │ c close pos │ x cancel all │ k kill-switch │ a advisor audit │ s stop',
        level: 'info',
      });
    }
    if (input === 's') process.exit(0);
  });

  const { cols, rows } = terminalSize;
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return <ResizeWarning cols={cols} rows={rows} />;
  }

  const symbols = config.symbols;
  const selectedSymbol = symbols[Math.max(0, Math.min(mtfPairIndex, symbols.length - 1))] ?? 'BTCUSDT';
  const displayLines = view === 'cockpit'
    ? renderCockpit({ ...state, spotPrices: lerpPrices, time, localTime, selPos: selectedIndex, isSyncing, totalWidth: cols, totalHeight: rows, currencyMode })
    : renderMtfScreen({
        symbols,
        selectedSymbol,
        selectedTimeframe: mtfTimeframe,
        marketStates: state.marketStates,
        mtfCandles: state.mtfCandles,
        spotPrices: lerpPrices,
        funding: state.funding,
        time,
        localTime,
        totalWidth: cols,
        totalHeight: rows,
        wsStatus: state.wsStatus,
        mode: state.mode,
      });

  return (
    <Box flexDirection="column" width={cols}>
      {displayLines.map((line, idx) => (
        <Text key={idx}>{line + '\x1b[K'}</Text>
      ))}
    </Box>
  );
}
