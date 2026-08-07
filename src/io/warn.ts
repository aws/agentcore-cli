import type { AppIO } from "./types";

// warn writes a non-fatal advisory to stderr, prefixed with "warning: " and
// newline-terminated. Advisories go to stderr (not stdout) so machine-readable
// stdout — e.g. a command's --json output — stays clean and parseable. A free
// function over AppIO rather than a method, so every AppIO producer (process
// streams, testIO) gets it without implementing anything.
export function warn(io: AppIO, message: string): void {
  io.stderr.write(`warning: ${message}\n`);
}
