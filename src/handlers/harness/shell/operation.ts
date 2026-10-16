import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import type { Context } from "../../../router";
import { ShellOperation } from "../../shell";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { HarnessShellLaunchContext } from "./launchContext";
import { normalizeHarnessShellRequest } from "./request";

type RunHarnessShellInput = {
  ctx: Context;
  core: Core;
  io: AppIO;
  harnessId: string;
  qualifier: string;
  launchContext?: HarnessShellLaunchContext;
};

export async function runHarnessShell(input: RunHarnessShellInput): Promise<void> {
  const { ctx, core, io, harnessId, qualifier, launchContext } = input;
  const shell = new ShellOperation(io);
  shell.requireTerminal();
  const options = coreOptsFromCtx(ctx);
  if (options.endpointUrl !== undefined) {
    throw new InputValidationError("harness shell does not support --endpoint-url");
  }
  const detail = await core.harness.getHarness(harnessId, options);
  const request = normalizeHarnessShellRequest(detail, {
    qualifier,
    runtimeSessionId: launchContext?.runtimeSessionId,
    shellId: launchContext?.shellId,
    bearerToken: launchContext?.bearerToken,
  });
  request.onReconnect = shell.onReconnect;
  io.stderr.write(`Connecting to Harness ${harnessId} (${qualifier})...\n`);
  await shell.run(await core.harness.openHarnessShell(request, options), {
    resource: "harness",
    id: harnessId,
    qualifier,
    region: options.region,
    requiresBearerToken: request.bearerToken !== undefined,
  });
}
