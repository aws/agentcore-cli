import { withProject } from "../../../middleware/";
import { Router } from "../../../router";
import { createAddConfigBundleHandler } from "./config-bundle";
import { createAddCredentialsHandler } from "./credentials";
import { createAddHarnessHandler } from "./harness";
import { createAddMemoryHandler } from "./memory";
import { createAddRuntimeHandler } from "./runtime";
import { createAddOnlineEvalHandler } from "./online-eval";
import { createAddOnlineInsightHandler } from "./online-insight";
import { createAddEvaluatorHandler } from "./evaluator";
import { createAddGatewayHandler } from "./gateway";
import { createAddGatewayTargetHandler } from "./gateway-target";
import { createAddGatewayConnectorHandler } from "./gateway-connector";
import { createAddPolicyEngineHandler } from "./policy-engine";
import { createAddPolicyHandler } from "./policy";
import type { AddProjectResourceConfig } from "./types";
import { createAddPaymentConnectorHandler } from "./payment-connector";
import { createAddPaymentManagerHandler } from "./payment-manager";

export function createAddProjectResourceHandler(config: AddProjectResourceConfig): Router {
  // The resources with a wizard of their own. Every other resource is listed in
  // the add menu as command line only and opens its help instead (see
  // CliOnlyScreen).
  const projectAdd = new Router("add", "add project resources").supportedTuiCommands("runtime");
  projectAdd.use(withProject({ projectManager: config.projectManager, cwd: process.cwd() }));
  projectAdd.handler(createAddConfigBundleHandler(config));
  projectAdd.handler(createAddHarnessHandler(config));
  projectAdd.handler(createAddMemoryHandler(config));
  projectAdd.handler(createAddRuntimeHandler(config));
  projectAdd.handler(createAddOnlineEvalHandler(config));
  projectAdd.handler(createAddOnlineInsightHandler(config));
  projectAdd.handler(createAddEvaluatorHandler(config));
  projectAdd.handler(createAddCredentialsHandler(config));
  projectAdd.handler(createAddGatewayHandler(config));
  projectAdd.handler(createAddGatewayTargetHandler(config));
  projectAdd.handler(createAddGatewayConnectorHandler(config));
  projectAdd.handler(createAddPolicyEngineHandler(config));
  projectAdd.handler(createAddPolicyHandler(config));
  projectAdd.handler(createAddPaymentManagerHandler(config));
  projectAdd.handler(createAddPaymentConnectorHandler(config));
  return projectAdd;
}
