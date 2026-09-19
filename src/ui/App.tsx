import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Orchestrator } from '../runtime/Orchestrator.js';
import { useStore } from '../store.js';
import { renderCockpit, ResizeWarning } from './panels.js';

export default function App() {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({
    cols: stdout?.columns ?? process.stdout.columns ?? 128,
    rows: stdout?.rows ?? process.stdout.rows ?? 58,
  }));

  useEffect(() => {
    const handleResize = () => {
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
  const [selPos, setSelPos] = useState(0);

  const { mode, equity, upnl, marginUsed, positions, logs, agents, spotPrices, funding, strategyMetrics } = useStore();
  const set = useStore((s) => s.set);
  const pushLog = useStore((s) => s.pushLog);

  useEffect(() => {
    orchestrator.on('state', (state) => set(state));
    orchestrator.on('log', (entry) => pushLog(entry));
    orchestrator.on('sync', (syncing: boolean) => setIsSyncing(syncing));
    orchestrator.start();

    const clockTimer = setInterval(() => {
      setTime(new Date().toISOString().slice(11, 19));
    }, 1000);

    return () => {
      orchestrator.stop();
      clearInterval(clockTimer);
    };
  }, [orchestrator, set, pushLog]);

  useInput((input, key) => {
    if (key.upArrow) setSelPos((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelPos((s) => Math.min(Math.max(0, positions.length - 1), s + 1));
    if (input === 'c' && positions[selPos]) orchestrator.closePosition(positions[selPos]);
    if (input === 'x') orchestrator.cancelAll();
    if (input === 'a' || input === 'i') orchestrator.askAdvisor();
    if (input === '?') {
      pushLog({
        ts: Date.now(),
        agent: 'SYSTEM',
        msg: 'COMMANDS: ↑↓ select pos │ c close pos │ x cancel all │ a advisor audit │ s stop',
        level: 'info',
      });
    }
    if (input === 's') process.exit(0);
  });

  const { cols, rows } = terminalSize;
  if (cols < 80 || rows < 40) {
    return <ResizeWarning cols={cols} rows={rows} />;
  }

  const cockpitLines = renderCockpit({
    mode,
    time,
    equity,
    upnl,
    marginUsed,
    positions,
    selPos,
    agents,
    logs,
    spotPrices,
    fundingRate: funding['ETHUSDT'],
    strategyMetrics,
    isSyncing,
    totalWidth: cols,
    totalHeight: rows,
  });

  return (
    <Box flexDirection="column" width={cols}>
      {cockpitLines.map((line, idx) => (
        <Text key={idx}>{line}</Text>
      ))}
    </Box>
  );
}
