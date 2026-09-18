import { expect, test } from "bun:test";
import { resolveScaffoldHarnessInput } from "./index";

// The deployed HarnessName is `<project>_default_<harness>` capped at 40 characters, so a
// project name of 15 characters is the longest that still fits doubled.
test.each([
  ["at the 15-character threshold", "P".repeat(15), /^P{15}$/],
  ["one over the threshold", "P".repeat(16), /^P{9}_[0-9a-f]{5}$/],
  ["at the 23-character project name maximum", "P".repeat(23), /^P{2}_[0-9a-f]{5}$/],
])("the default harness name for a project %s", (_label, projectName, pattern) => {
  expect(resolveScaffoldHarnessInput({ name: projectName }).name).toMatch(pattern);
});
