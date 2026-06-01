import { ANSI } from './constants';
import { type UpdateCheckResult, printUpdateNotification } from './update-notifier';

export function printTelemetryNotice(): void {
  const { yellow, reset } = ANSI;
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
