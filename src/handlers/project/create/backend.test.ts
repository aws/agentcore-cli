import { expect, test } from "bun:test";
import { validateBackendCreateInput } from "./backend";
import { resolveRuntimeTemplateShortcut } from "../shortcuts";

test.each(["agent-python-minimal", "agent-python-langchain"] as const)(
  "accepts the %s Terraform template",
  (template) => {
    expect(() =>
      validateBackendCreateInput({
        name: "Demo",
        managedBy: "TERRAFORM",
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(template),
      }),
    ).not.toThrow();
  },
);

test.each([
  "agent-python-strands",
  "agent-python-strands-container",
  "agent-typescript-strands",
] as const)("rejects unsupported %s Terraform templates before creation", (template) => {
  expect(() =>
    validateBackendCreateInput({
      name: "Demo",
      managedBy: "TERRAFORM",
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(template),
    }),
  ).toThrow("Terraform preview");
});

test("existing CDK templates retain their behavior", () => {
  expect(() =>
    validateBackendCreateInput({
      name: "Demo",
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-strands"),
    }),
  ).not.toThrow();
});
