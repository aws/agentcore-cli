// Test preload: pin ANSI color OFF so rendered Ink frames are deterministic.
//
// chalk/supports-color decides whether Ink emits color escape codes from
// `process.stdout.isTTY` (and FORCE_COLOR/NO_COLOR). That makes frame output
// environment-dependent: `bun test` in a terminal has a TTY, so color is ON and
// styled text like a highlighted menu item renders as `❯ \u001b[1mharness`,
// breaking plain-substring assertions such as `toContain("❯ harness")`. Piping
// (`bun test > log`) is not a TTY, so color is OFF and the same assertions pass.
//
// Setting FORCE_COLOR=0 here — before any test file imports Ink/chalk — forces
// color off everywhere, so frames are plain text regardless of TTY. This file
// is registered as a Bun test preload in bunfig.toml, which runs before test
// modules load (supports-color reads FORCE_COLOR at import time).
process.env.FORCE_COLOR = "0";

// The glyph table (components/ui/_core.ts) picks Unicode or ASCII from the
// terminal env at import time. Pin the Windows Terminal marker so frame
// assertions on ❯ ✗ ↵ hold on a plain conhost dev box as well.
process.env.WT_SESSION ??= "bun-test";
