#!/usr/bin/env node
/*
 * Bug-bash TUI recorder. Launches the AgentCore CLI TUI under private-tui-harness
 * (tui-harness-mcp), records one frame per screen change, drives a short scripted
 * key sequence, and writes an MP4 to $OUT.
 *
 * The key script is env-tunable (BUGBASH_KEYS) on purpose: a live TUI's navigation
 * drifts across versions, so the sequence is a calibration knob, not a hardcoded
 * assumption. Teams tune BUGBASH_KEYS/BUGBASH_ARGS per what the current TUI expects.
 */
import { resolve } from "node:path";

const dist = process.env.TUI_HARNESS_DIST;
if (!dist) throw new Error("TUI_HARNESS_DIST must point at private-tui-harness dist/index.js");

const { TuiSession } = await import(resolve(dist));

const out = process.env.OUT || "bug-bash.mp4";
const command = process.env.BUGBASH_CMD || "bun";
const args = (process.env.BUGBASH_ARGS || "run src/index.ts").split(" ").filter(Boolean);
// Semicolon-separated steps sent in order; each is text or a special key name
// understood by tui-harness (enter, down, up, escape, q, ctrl+c, ...).
const keys = (process.env.BUGBASH_KEYS || "down;down;enter;escape;q").split(";").filter(Boolean);
const settleMs = Number(process.env.BUGBASH_SETTLE_MS || 1500);

const session = await TuiSession.launch({
  command,
  args,
  cwd: process.cwd(),
  cols: 140,
  rows: 40,
  env: { CI: "1", TERM: "xterm-256color" },
});

session.startRecording();
try {
  await session.sendKeys("", settleMs); // let the first screen settle before driving
  for (const k of keys) {
    await session.sendKeys(k, settleMs);
  }
} finally {
  await session.stopRecording(resolve(out));
  await session.close("SIGINT").catch(() => {});
  console.log(`Recorded TUI session -> ${out}`);
}
