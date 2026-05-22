import { type UpdateCheckResult, printUpdateNotification } from './update-notifier';

export function printTelemetryNotice(): void {
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  process.stderr.write(
    [
      '',
      `${yellow}The AgentCore CLI will soon begin collecting aggregated, anonymous usage`,
      'analytics to help improve the tool.',
      'To opt out:          agentcore telemetry disable',
      `To learn more:       agentcore telemetry --help${reset}`,
      '',
      '',
    ].join('\n')
  );
}

export function printPostCommandNotices(
  isFirstRun: boolean,
  updateCheck: Promise<UpdateCheckResult | null>
): Promise<void> {
  if (isFirstRun) {
    printTelemetryNotice();
  }
  return updateCheck.then(result => {
    if (result?.updateAvailable) {
      printUpdateNotification(result);
    }
  });
}
