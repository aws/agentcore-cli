import { ExecLogger } from '../../../logging';
import { findAvailablePort } from '../server';
import { openBrowser } from '../utils';
import { WEB_UI_DEFAULT_PORT } from './constants';
import { type WebUIOptions, WebUIServer } from './web-server';

export interface RunWebUIOptions {
  /** Options to pass to WebUIServer (minus uiPort, which is resolved automatically) */
  serverOptions: Omit<WebUIOptions, 'uiPort' | 'onReady' | 'onLog'>;
  /** Logger command label (e.g. 'dev') */
  logLabel: string;
  /** Optional log handler override. Defaults to console logging errors. */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Shared entry point for launching the web UI.
 * Handles port discovery, logger setup, browser launch, SIGINT, and keep-alive.
 */
export async function runWebUI(opts: RunWebUIOptions): Promise<void> {
  const { serverOptions, logLabel } = opts;

  const logger = new ExecLogger({ command: logLabel });
  const uiPort = await findAvailablePort(WEB_UI_DEFAULT_PORT);
  if (uiPort !== WEB_UI_DEFAULT_PORT) {
    console.log(`Port ${WEB_UI_DEFAULT_PORT} in use, using ${uiPort}`);
  }

  console.log(`Starting web UI...`);
  console.log(`Log: ${logger.getRelativeLogPath()}`);

  const onLog =
    opts.onLog ??
    ((level: 'info' | 'warn' | 'error', msg: string) => {
      if (level === 'error') console.error(`Web UI: ${msg}`);
    });

  const webUI = new WebUIServer({
    ...serverOptions,
    uiPort,
    onReady: url => {
      const chatUrl = url;
      console.log(`\nChat UI: ${chatUrl}`);
      console.log(`Press Ctrl+C to stop\n`);
      openBrowser(chatUrl);
    },
    onLog,
  });

  webUI.start();

  process.on('SIGINT', () => {
    console.log('\nStopping servers...');
    webUI.stop();
  });

  // Keep process alive
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  await new Promise(() => {});
}
