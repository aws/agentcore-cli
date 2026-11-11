import { regionFromArn, resourceNameFromArn } from "../../arn";
import { IMPORT_NOTES_FILE, renderImportNotes } from "./importNotes";
import { generateImportPyproject } from "./pyproject";
import type {
  BedrockAgentImportNote,
  BedrockAgentImportPlan,
  BedrockAgentImportRequest,
  BedrockAgentSnapshot,
  ImportedFunctionParameter,
} from "./types";

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

export abstract class BaseBedrockAgentTranslator {
  protected readonly notes: BedrockAgentImportNote[];

  constructor(
    protected readonly snapshot: BedrockAgentSnapshot,
    protected readonly request: BedrockAgentImportRequest,
  ) {
    this.notes = snapshot.notes.map((note) => ({ ...note }));
  }

  abstract translate(): BedrockAgentImportPlan;

  protected buildPlan(
    mainPy: string,
    collaboratorFiles: Record<string, string>,
    frameworkNotes: BedrockAgentImportNote[] = [],
  ): BedrockAgentImportPlan {
    this.notes.push(...frameworkNotes);
    // Every agent in the tree contributes follow-up notes; a collaborator's unimplemented action
    // groups and knowledge-base permissions are the customer's problem too.
    for (const snapshot of snapshotTree(this.snapshot)) this.addCommonNotes(snapshot);

    const files: Record<string, string> = {
      "main.py": mainPy,
      ...collaboratorFiles,
      "pyproject.toml": generateImportPyproject({
        runtimeName: this.request.runtimeName,
        framework: this.request.framework,
        hasMemory: this.request.memory !== "none",
        hasCodeInterpreter: this.hasCodeInterpreter(),
      }),
    };

    files[IMPORT_NOTES_FILE] = renderImportNotes(this.snapshot, this.notes);
    return {
      framework: this.request.framework,
      sourceAgentId: this.snapshot.sourceAgentId,
      // From the request, which always carries it, rather than a non-null assertion on the snapshot.
      sourceAgentAliasId: this.request.agentAliasId,
      sourceAgentVersion: this.snapshot.sourceAgentVersion,
      description: this.snapshot.description,
      files,
      notes: this.notes,
    };
  }

  protected generateSystemPrompt(): string {
    return `SYSTEM_PROMPT = """${escapePythonTripleQuoted(this.snapshot.instruction)}"""`;
  }

  protected generateFunctionTools(): string {
    const functions = this.snapshot.actionGroups.flatMap((group) =>
      group.functions.map((fn) => ({ groupName: group.name, fn })),
    );
    if (functions.length === 0) return "";

    const sections = ["# Action group tools"];
    for (const { groupName, fn } of functions) {
      const parameters = Object.entries(fn.parameters)
        .sort(([, left], [, right]) => Number(right.required) - Number(left.required))
        .map(([name, parameter]) => pythonParameter(name, parameter))
        .join(", ");
      sections.push(`@tool
def ${pythonIdentifier(fn.name)}(${parameters}) -> str:
    """${escapePythonTripleQuoted(fn.description ?? `Function from ${groupName}`)}"""
    # TODO: Implement the original Bedrock Agent action group behavior.
    return json.dumps({"status": "not_implemented", "function": "${escapePythonString(fn.name)}"})`);
    }
    return sections.join("\n\n");
  }

  // Tree-wide: a collaborator-only code interpreter still needs the dependency in pyproject.toml.
  protected hasCodeInterpreter(): boolean {
    return snapshotTree(this.snapshot).some((snapshot) =>
      snapshot.actionGroups.some(
        (group) => group.parentActionSignature === "AMAZON.CodeInterpreter",
      ),
    );
  }

  protected functionToolNames(): string[] {
    return this.snapshot.actionGroups.flatMap((group) =>
      group.functions.map((fn) => pythonIdentifier(fn.name)),
    );
  }

  protected addCommonNotes(snapshot: BedrockAgentSnapshot): void {
    const agent = snapshot === this.snapshot ? "" : ` (collaborator '${snapshot.agentName}')`;
    for (const actionGroup of snapshot.actionGroups) {
      if (actionGroup.functions.length > 0) {
        this.notes.push({
          category: `action-group implementation${agent}`,
          message:
            `Generated typed stubs for action group '${actionGroup.name}'. ` +
            "Implement their business logic before relying on them in production.",
        });
      }
      const unsupportedFeatures = [
        actionGroup.hasApiSchema ? "OpenAPI schema" : undefined,
        actionGroup.hasLambdaExecutor ? "Lambda executor" : undefined,
        actionGroup.returnsControl ? "return-control behavior" : undefined,
      ].filter(Boolean);
      if (unsupportedFeatures.length > 0) {
        this.notes.push({
          category: `action-group integration${agent}`,
          message:
            `Action group '${actionGroup.name}' used ${unsupportedFeatures.join(", ")}. ` +
            "Implement the equivalent integration manually.",
        });
      }
      if (actionGroup.parentActionSignature === "AMAZON.UserInput") {
        this.notes.push({
          category: `user-input action${agent}`,
          message:
            `Action group '${actionGroup.name}' used AMAZON.UserInput, which has no direct ` +
            "standalone-agent equivalent.",
        });
      }
      if (
        actionGroup.parentActionSignature &&
        actionGroup.parentActionSignature !== "AMAZON.UserInput" &&
        actionGroup.parentActionSignature !== "AMAZON.CodeInterpreter"
      ) {
        this.notes.push({
          category: `built-in action${agent}`,
          message:
            `Action group '${actionGroup.name}' used '${actionGroup.parentActionSignature}' and ` +
            "was not translated automatically.",
        });
      }
    }

    if (snapshot.hasPromptOverrides) {
      this.notes.push({
        category: `prompt overrides${agent}`,
        message:
          "The generated agent uses the source instruction as its system prompt and the " +
          "ORCHESTRATION inference settings. Migrate custom prompt templates, parser Lambdas, " +
          "additional model fields, and pre/post-processing prompt steps manually.",
      });
    }

    if (snapshot.knowledgeBases.length > 0) {
      const resources = snapshot.knowledgeBases.map(
        (knowledgeBase) =>
          knowledgeBase.arn ??
          `arn:*:bedrock:${snapshot.region}:*:knowledge-base/${knowledgeBase.id}`,
      );
      this.notes.push({
        category: `knowledge-base IAM${agent}`,
        message:
          "Grant the Runtime execution role bedrock:Retrieve on: " + resources.join(", ") + ".",
      });
    }

    if (snapshot.sourceMemoryEnabled && this.request.memory === "none") {
      this.notes.push({
        category: `memory disabled${agent}`,
        message:
          "The source Bedrock Agent used memory, but the import selected --memory none. " +
          "The generated Runtime is stateless across invocations.",
      });
    }
  }
}

/**
 * langchain_aws refuses to infer a provider from any `arn:` model id, so `ChatBedrock` needs one
 * supplied. A foundation-model ARN carries it in the resource name
 * (`.../foundation-model/anthropic.claude-...`); provisioned-model and inference-profile ARNs do
 * not, and only a service lookup could resolve those.
 */
export function providerFromModelArn(foundationModel: string): string | undefined {
  if (!foundationModel.startsWith("arn:")) return undefined;
  const resource = resourceNameFromArn(foundationModel);
  const provider = resource.split(".")[0];
  return provider && provider !== resource ? provider.toLowerCase() : undefined;
}

/**
 * A knowledge base can live in a different region than the agent, so prefer the region encoded in
 * its ARN and fall back to the agent's region only when the ARN was unavailable.
 */
export function knowledgeBaseRegion(knowledgeBase: { arn?: string }, agentRegion: string): string {
  return regionFromArn(knowledgeBase.arn ?? "") ?? agentRegion;
}

/** The root snapshot followed by every collaborator reachable from it, depth-first. */
export function snapshotTree(root: BedrockAgentSnapshot): BedrockAgentSnapshot[] {
  return [root, ...root.collaborators.flatMap((collaborator) => snapshotTree(collaborator.agent))];
}

export function pythonIdentifier(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, "_");
  const identifier = /^\d/.test(sanitized) ? `_${sanitized}` : sanitized || "unnamed";
  return PYTHON_KEYWORDS.has(identifier) ? `${identifier}_` : identifier;
}

export function escapePythonString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

export function escapePythonTripleQuoted(value: string): string {
  // Escape every double-quote, not just """ runs. A quote left adjacent to the
  // closing """ delimiter (a trailing " or "") merges into """" and breaks the
  // literal; escaping each quote keeps it inside the string and also collapses
  // any longer run safely.
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function pythonParameter(name: string, parameter: ImportedFunctionParameter): string {
  const type = pythonType(parameter.type);
  return `${pythonIdentifier(name)}: ${parameter.required ? type : `${type} | None = None`}`;
}

function pythonType(value: string): string {
  switch (value) {
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "array":
      return "list";
    default:
      return "str";
  }
}
