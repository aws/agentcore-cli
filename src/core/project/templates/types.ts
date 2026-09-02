import type { FsTreeNode } from "./fsTree";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { MemorySchema } from "../../../projectSchemas/memory";
import type { CredentialSchema } from "../../../projectSchemas/credential";
import type { HarnessRegistryEntry } from "../../../projectSchemas/harness";
import type { Evaluator } from "../../../projectSchemas/evaluator";
import type z from "zod";

/** AgentCore Project Spec Entries that rendered as part of a {@link Template} **/
export type SpecEntries = {
  runtimes?: ProjectRuntime[];
  credentials?: z.infer<typeof CredentialSchema>[];
  memories?: z.infer<typeof MemorySchema>[];
  harnesses?: HarnessRegistryEntry[];
  evaluators?: Evaluator[];
};

/** A group of files and resources that can be rendered into a project **/
export type Template = {
  tree: FsTreeNode;
  spec: SpecEntries;
};

/** A standard interface for resolving templates from a given input of paramters **/
export interface TemplateResolver<T> {
  resolve(input: T): Promise<Template>;
}

/** An interface for rendering templates by substituing placeholders across a templatedString **/
export interface TemplateRenderer {
  render(templatedString: string, context: Record<string, unknown>): string;
}
