import z from "zod";
import semver from "semver";
import { createHandler, flag } from "../../router";
import { JsonRendererKey } from "../../tui";
import { runWithProgress } from "../../tui/progress";
import type { AppIO } from "../../io";
import { CliVersionManagerKey, JsonKey } from "../keys";
import type { CliVersionManager, UpdateCheckResult } from "../../cliVersionManager";

async function checkForUpdate(versionManager: CliVersionManager): Promise<UpdateCheckResult> {
  const currentVersion = versionManager.getCurrentVersion();
  const latestVersion = await versionManager.getLatestVersion({ ignoreCache: true });
  const versionComparison = semver.compare(latestVersion, currentVersion);
  return {
    status:
      versionComparison === 0
        ? "up-to-date"
        : versionComparison < 0
          ? "newer-local"
          : "update-available",
    currentVersion,
    latestVersion,
  };
}

export const createUpdateHandler = (io: AppIO) =>
  createHandler({
    name: "update",
    description: "check for and install CLI updates",
    flags: [flag("check", "check for updates without installing", z.boolean().default(false))],
    handle: async (ctx, flags) => {
      const versionManager = ctx.require(CliVersionManagerKey);
      const updateResult = flags.check
        ? await checkForUpdate(versionManager)
        : await runWithProgress(versionManager.update(), {
            io,
            interactive: !ctx.require(JsonKey),
          });
      ctx.require(JsonRendererKey).renderJson(updateResult);
    },
  });
