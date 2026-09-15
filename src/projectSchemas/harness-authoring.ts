import { HarnessSpecSchema } from "./harness";

/** Scaffold references name future YAML-relative files; validate syntax without reading them. */
export const HarnessAuthoringSchema = HarnessSpecSchema.refine(
  ({ systemPrompt }) => systemPrompt !== "file://",
  { path: ["systemPrompt"], message: "systemPrompt: file:// requires a path" },
);
