import { InputValidationError } from "../../../errors";
import type { CreateProjectInput } from "../types";

/** Shared by CLI, TUI, and the manager so unsupported templates fail before scaffolding. */
export function validateBackendCreateInput(input: CreateProjectInput): void {
  if (input.managedBy !== "TERRAFORM") return;
  const runtime = input.scaffoldRuntimeInput;
  if (
    input.scaffoldHarnessInput ||
    (runtime &&
      (runtime.build !== "CodeZip" ||
        runtime.language !== "Python" ||
        (runtime.memory?.strategies.length ?? 0) > 0 ||
        (runtime.modelProvider !== undefined && runtime.modelProvider !== "Bedrock")))
  ) {
    throw new InputValidationError(
      "The Terraform preview supports Python CodeZip runtimes and short-term memory. " +
        "Choose --template agent-python-minimal, agent-python-langchain, or empty. " +
        "Harnesses, containers, TypeScript packaging, memory strategies, and credential providers are not supported yet.",
    );
  }
}
