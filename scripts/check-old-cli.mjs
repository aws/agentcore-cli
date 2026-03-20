import { execSync } from 'node:child_process';
import { detectOldToolkit, formatErrorMessage } from './check-old-cli.lib.mjs';

if (process.env.AGENTCORE_SKIP_CONFLICT_CHECK === '1') process.exit(0);

const detected = detectOldToolkit((cmd) =>
  execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
);

if (detected.length > 0) {
  console.error(formatErrorMessage(detected));
  process.exit(1);
}
