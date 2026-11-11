export function runtimeShellErrorHint(error: Error): string | undefined {
  if (error.message !== "Server rejected WebSocket connection: HTTP 400") return undefined;
  return (
    "If this Runtime is managed by a harness, open its shell with:\n" +
    "agentcore harness shell --id <harness-id>"
  );
}
