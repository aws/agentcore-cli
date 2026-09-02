/**
 * Writes the telemetry-collection notice to the given stream on the first run of
 * the CLI, unless telemetry is already disabled.
 */
export function printFirstRunNotice(
  isFirstRun: boolean,
  telemetryEnabled: boolean,
  out: { write(text: string): void },
): void {
  if (!isFirstRun || !telemetryEnabled) return;

  out.write(
    [
      "",
      "The AgentCore CLI collects aggregated, anonymous usage analytics to help improve the tool.",
      "To opt out:   agentcore config telemetry.enabled false",
      "To audit:     agentcore config telemetry.audit true",
      "",
    ].join("\n"),
  );
}
