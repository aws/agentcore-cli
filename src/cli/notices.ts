import { ANSI } from './constants';
import { resolveTelemetryPreference } from './telemetry/config';
import { type UpdateCheckResult, printUpdateNotification } from './update-notifier';

export async function printTelemetryNotice(): Promise<void> {
  const pref = await resolveTelemetryPreference();
  if (!pref.enabled) return;

  const { yellow, reset } = ANSI;
  process.stderr.write(
    [
      '',
      `${yellow}The AgentCore CLI collects aggregated, anonymous usage`,
      'analytics to help improve the tool.',
      'To opt out:          agentcore config telemetry.enabled false',
      `To audit:            agentcore config telemetry.audit true`,
      `To learn more:       agentcore telemetry --help`,
      `${reset}`,
      '',
    ].join('\n')
  );
}

export async function printPostCommandNotices(
  isFirstRun: boolean,
  updateCheck: Promise<UpdateCheckResult | null>
): Promise<void> {
  if (isFirstRun) {
    await printTelemetryNotice();
  }
  const result = await updateCheck;
  if (result?.updateAvailable) {
    printUpdateNotification(result);
  }
}
