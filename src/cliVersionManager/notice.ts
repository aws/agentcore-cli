import type { CliVersionManager } from "./types";

export async function printUpdateNotice(
  versionManager: CliVersionManager,
  output: { write(text: string): void },
): Promise<void> {
  try {
    if (!(await versionManager.shouldShowUpdateNotice())) return;
    const latestVersion = await versionManager.getLatestVersion();
    output.write(
      `\nUpdate available: ${versionManager.getCurrentVersion()} → ${latestVersion}\n` +
        "Run `agentcore update` to update.\n",
    );
  } catch {
    // Update notices are best-effort.
  }
}
