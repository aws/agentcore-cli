import { ANSI } from '../constants';

/**
 * Warn (once, on stderr) when a secret was supplied as a literal CLI flag.
 *
 * Anything passed on the command line is captured by shell history and the
 * process table the instant the command is typed — independent of how the value
 * is later stored. Encrypting `.env.local` at rest does not undo that leak, so
 * every command that accepts a secret as a flag surfaces this nudge toward the
 * interactive (masked) flow.
 *
 * @param secretValues the resolved values of the command's secret flags; the
 *   warning fires if ANY is defined.
 * @param json suppress under `--json` so machine-readable stdout stays clean.
 * @param command the command to suggest running interactively (e.g.
 *   "add payment-connector", "add credential").
 */
export function warnOnLiteralSecretFlag(
  secretValues: (string | undefined)[],
  json: boolean | undefined,
  command: string
): void {
  const usedLiteralSecretFlag = secretValues.some(v => v !== undefined);
  if (!usedLiteralSecretFlag || json) return;
  process.stderr.write(
    `${ANSI.yellow}Warning: passing secrets as CLI flags exposes them to shell history and the ` +
      `process table. Prefer interactive mode (run \`agentcore ${command}\` with no ` +
      `secret flags) for masked entry.${ANSI.reset}\n`
  );
}
