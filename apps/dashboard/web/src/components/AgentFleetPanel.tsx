/**
 * AgentFleetPanel — observability cockpit for the autonomous strategy fleet.
 * Visualizes each agent as an independent entity with designated specialization,
 * live execution rate, win rate, and latest signal evaluation.
 */

import { useDashboardStore, type AgentRow } from "../store.js";

const AGENT_SPECIALIZATIONS: Record<string, string> = {
  "MOMENTUM-γ": "Trend Momentum & Breakout",
  "MEAN-REVERT-θ": "Bollinger & VWAP Reversion",
  "STRUCTURE-TREND-η": "HTF Structure & BOS",
  "STRUCT-LIQ-η": "Liquidity Sweeps & CHOCH",
  "CROWDING-ι": "Funding & OI Divergence",
  "FUNDING-ARB-α": "Perp Basis & Rate Arbitrage",
  "ADAPTIVE-ST-ζ": "Dynamic SuperTrend Ratchet",
};

export default function AgentFleetPanel({ className }: { className: string }) {
  const agents = useDashboardStore((s) => s.agents);
  const activeCount = agents.filter((a) => a.status === "RUNNING").length;

  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <span>Agent Swarm Roster</span>
        <span className="spacer" />
        <span className="badge-glow">{activeCount} Autonomous Units</span>
      </div>
      <div className="panel-body no-pad">
        <div className="agent-stream">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
          {agents.length === 0 && (
            <div className="agent-empty-radar">
              <span className="radar-ping" />
              <span>Scanning agent swarm channels…</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AgentCard({ agent }: { agent: AgentRow }) {
  const spec = AGENT_SPECIALIZATIONS[agent.id] ?? "Autonomous Quantitative Model";
  const execRate =
    agent.totalDecisions > 0
      ? ((agent.executed / agent.totalDecisions) * 100).toFixed(0)
      : null;

  return (
    <div className="agent-entity-card">
      <div className="entity-header">
        <div className="entity-avatar">
          <span className="agent-status-orb running" />
          <span className="entity-name">{agent.id}</span>
        </div>
        <span className="spacer" />
        <span className="entity-spec">{spec}</span>
      </div>

      <div className="entity-metrics">
        <div className="metric-chip">
          <span className="metric-label">Decisions</span>
          <span className="metric-val">{agent.totalDecisions}</span>
        </div>
        <div className="metric-chip">
          <span className="metric-label">Filled</span>
          <span className="metric-val text-up">{agent.executed}</span>
        </div>
        <div className="metric-chip">
          <span className="metric-label">Exec Rate</span>
          <span className="metric-val">{execRate ? `${execRate}%` : "—"}</span>
        </div>
        <div className="metric-chip">
          <span className="metric-label">Win Rate</span>
          <span className={`metric-val ${agent.winRate && agent.winRate >= 50 ? "text-up" : ""}`}>
            {agent.winRate != null ? `${agent.winRate.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>

      {agent.lastSignal && <AgentSignalBubble signal={agent.lastSignal} />}
    </div>
  );
}

function AgentSignalBubble({ signal }: { signal: NonNullable<AgentRow["lastSignal"]> }) {
  const isBuy = signal.side.includes("LONG") || signal.side.includes("BUY");
  const confPct = Math.round((signal.confidence ?? 0) * 100);

  return (
    <div className="agent-signal-bubble">
      <div className="signal-bubble-top">
        <span className="signal-tag">LATEST DISPATCH</span>
        <span className={`signal-action ${isBuy ? "buy" : "sell"}`}>
          {signal.side}
        </span>
        <span className="signal-target">{signal.symbol}</span>
        <span className="spacer" />
        <span className={`signal-status-pill ${signal.status}`}>
          {signal.status}
        </span>
      </div>
      <div className="signal-confidence-bar">
        <div className="confidence-track">
          <div className="confidence-fill" style={{ width: `${confPct}%` }} />
        </div>
        <span className="confidence-num">{confPct}% confidence</span>
      </div>
    </div>
  );
}
