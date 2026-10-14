/**
 * Read-only safety contract test for the dashboard server.
 *
 * Locks in the invariant from the OpenTerminal reuse audit's section 3:
 * the dashboard must NOT expose any write endpoints — no order placement,
 * no kill-switch toggle, no HWM reset, no approvals mutation. Operators
 * must use the authenticated CLI command path for any write action.
 *
 * This test reads the dashboard server source files and asserts that
 * no route handler is registered for paths that would let the UI bypass
 * risk gates or execution gates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.resolve(here, "..", "apps", "dashboard", "server", "routes");

const routeFiles = readdirSync(routesDir).filter((f) => f.endsWith(".ts"));

// Aggregate all source content so we can scan once for forbidden patterns.
const allSource = routeFiles
  .map((f) => readFileSync(path.join(routesDir, f), "utf8"))
  .join("\n");

// Forbidden path prefixes — the dashboard MUST NOT expose these.
// Each entry is checked as an exact quoted string (so /api/orders does NOT
// match /api/orders/list, and /api/orders/place does NOT match the read
// path /api/orders/history). The dashboard must not register any endpoint
// that lets the UI bypass risk gates or execution gates.
const FORBIDDEN_PATHS = [
  "/api/orders/place",
  "/api/orders/cancel",
  "/api/orders/close",
  "/api/orders/reduce",
  "/api/risk/kill-switch/toggle",
  "/api/risk/kill-switch/halt",
  "/api/risk/kill-switch/resume",
  "/api/risk/hwm/reset",
  "/api/risk/approvals/write",
  "/api/risk/approvals/update",
  "/api/risk/approvals/revoke",
  "/api/risk/limits/update",
  "/api/position-manager/advance",
  "/api/position-manager/reset",
  "/api/execution/run",
  "/api/execution/place",
  "/api/cancel",
  "/api/trade/place",
  "/api/trade/close",
];

test("dashboard server routes do not register any write endpoints", () => {
  for (const forbidden of FORBIDDEN_PATHS) {
    const quotedDouble = `"${forbidden}"`;
    const quotedSingle = `'${forbidden}'`;
    const quotedBacktick = `\`${forbidden}\``;
    assert.ok(
      !allSource.includes(quotedDouble) &&
        !allSource.includes(quotedSingle) &&
        !allSource.includes(quotedBacktick),
      `dashboard routes must not register ${forbidden} — write actions must go through the CLI command path`,
    );
  }
});

test("dashboard server routes only register GET handlers", () => {
  // The Express app pattern we use: app.get(...). Any app.post / app.put /
  // app.patch / app.delete would be a write action.
  for (const f of routeFiles) {
    const src = readFileSync(path.join(routesDir, f), "utf8");
    assert.ok(
      !/\bapp\.(post|put|patch|delete)\s*\(/.test(src),
      `${f}: dashboard routes must be read-only — app.post/put/patch/delete are forbidden`,
    );
  }
});

test("dashboard server never imports ExecutorAgent.execute or sendOrder", () => {
  // ExecutorAgent.execute is the write-side action that places orders.
  // The dashboard must not import it.
  for (const f of routeFiles) {
    const src = readFileSync(path.join(routesDir, f), "utf8");
    assert.ok(
      !/ExecutorAgent/.test(src) || /type ExecutorAgent|import type/.test(src),
      `${f}: dashboard routes must not import ExecutorAgent directly`,
    );
    assert.ok(
      !/sendOrder|newClientOrderId/.test(src),
      `${f}: dashboard routes must not call sendOrder or newClientOrderId`,
    );
  }
});

test("dashboard server context reuses the agent's BinanceService — not a spot provider", () => {
  const ctxFile = path.resolve(here, "..", "apps", "dashboard", "server", "context.ts");
  const src = readFileSync(ctxFile, "utf8");
  // The context MUST import from the parent project's src/binance/client.js
  assert.ok(
    src.includes("../../../src/binance/client.js"),
    "context.ts must reuse the agent's BinanceService from src/binance/client.js",
  );
  // The context MUST NOT reference spot endpoints (audit section 3)
  assert.ok(
    !/api\/v3\/(ticker|klines|depth)/.test(src),
    "context.ts must not reference Binance spot endpoints (/api/v3/*)",
  );
});
