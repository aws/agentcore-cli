import { accessSync, constants, statSync } from "node:fs";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import z from "zod";
import {
  ChoiceField,
  ResourceChoiceField,
  RevealChoiceField,
  Step,
  Summary,
  TextAreaField,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import { SourceResolver } from "../../../../io";
import { PolicyNameSchema, type PolicyEngine } from "../../../../projectSchemas/policy";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import {
  inferAuthorizationPhase,
  toAddPolicyInput,
  type PolicyEnforcementMode,
  type PolicyInput,
} from "./index";

const BREADCRUMB = ["agentcore", "add", "policy"];
const DESCRIPTION = "add a Cedar Policy to a project Policy Engine";
const ADD_MENU = "/agentcore/add";

// Where the statement comes from. A file is the way `--statement file://…`
// arrives, and the flag path records the path as the policy's sourceFile, so
// the wizard keeps that provenance rather than pasting the file's text.
type StatementSource = "inline" | "file";

const SOURCE_CHOICES: Choice<StatementSource>[] = [
  {
    value: "inline",
    label: "type or paste the Cedar statement",
    description: "on the next step, over as many lines as it takes",
  },
  {
    value: "file",
    label: "load it from a file",
    description: "the path is recorded as the policy's sourceFile",
  },
];

const ENFORCEMENT_CHOICES: Choice<PolicyEnforcementMode>[] = [
  {
    value: "active",
    label: "active (default)",
    description: "deny the calls this policy forbids",
  },
  {
    value: "log-only",
    label: "log-only",
    description: "record what this policy would decide, without blocking",
  },
];

const STATEMENT_EXAMPLE = "forbid (principal, action, resource);";

// readableFileSchema accepts a path to an existing, readable file — checked
// before the step advances, so a typo is caught here rather than on submit.
export const readableFileSchema: z.ZodType = z.string().superRefine((path, ctx) => {
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.R_OK);
  } catch {
    ctx.addIssue({ code: "custom", message: `no readable file at '${path}'` });
  }
});

type PolicyFormValues = {
  engine: string;
  name: string;
  source: StatementSource;
  statement: string;
  statementFile: string;
  enforcement: PolicyEnforcementMode;
};

// readStatementFile reads a statement the way `--statement file://…` does:
// through SourceResolver, so a file that is not valid UTF-8 is refused rather
// than decoded with replacement characters that would change what the policy
// matches. Nothing here reads stdin, so the resolver gets none.
function readStatementFile(path: string): Promise<string> {
  return new SourceResolver({}).resolveText("statement", `file://${path}`);
}

// StatementLoad is what the review knows about the statement: a pasted one is
// ready at once; a file is read when the review mounts.
type StatementLoad =
  | { state: "reading" }
  | { state: "ready"; statement: string }
  | { state: "failed"; message: string };

// toPolicyInput is the answers as the flag path would state them; the phase is
// left for the shared builder to infer, exactly as an omitted
// --authorization-phase is. --description and --validation-mode stay flag-only.
export function toPolicyInput(values: PolicyFormValues, statement: string): PolicyInput {
  return {
    engine: values.engine,
    name: values.name,
    statement,
    sourceFile: values.source === "file" ? values.statementFile : undefined,
    enforcementMode: values.enforcement,
  };
}

function firstLine(text: string): string {
  const lines = text.trim().split("\n");
  const first = lines[0] ?? "";
  const shown = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  const rest = lines.length - 1;
  return rest > 0 ? `${shown} (+${rest} more ${rest === 1 ? "line" : "lines"})` : shown;
}

function summaryOf(values: PolicyFormValues, load: StatementLoad): Record<string, string> {
  return {
    "policy engine": values.engine,
    policy: values.name,
    statement:
      values.source === "file" ? `from ${values.statementFile}` : firstLine(values.statement),
    enforcement: values.enforcement,
    // The phase is a substring heuristic over the statement, so the guess is
    // shown before it is written; --authorization-phase overrides it.
    "authorization phase":
      load.state === "reading"
        ? `reading ${values.statementFile}…`
        : load.state === "failed"
          ? `(statement unreadable: ${load.message})`
          : `${inferAuthorizationPhase(load.statement)} · inferred from the statement`,
  };
}

// PolicyReview loads a file-sourced statement when the review step mounts —
// asynchronously, so the TUI never blocks on a read, and only after the source
// step has checked that the path is a readable file. A pasted statement needs
// no loading.
function PolicyReview({ values }: { values: PolicyFormValues }) {
  const [load, setLoad] = useState<StatementLoad>(() =>
    values.source === "inline"
      ? { state: "ready", statement: values.statement }
      : { state: "reading" },
  );

  // A pasted statement is ready from the initializer; only a file has anything
  // to load, and it resolves through the promise rather than in the effect body.
  useEffect(() => {
    if (values.source !== "file") return;
    let cancelled = false;
    readStatementFile(values.statementFile).then(
      (statement) => {
        if (!cancelled) setLoad({ state: "ready", statement });
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoad({
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [values.source, values.statementFile]);

  return <Summary items={summaryOf(values, load)} />;
}

function engineChoices(engines: readonly PolicyEngine[]): Choice<string>[] {
  return engines.map((engine) => ({
    value: engine.name,
    label: engine.name,
    description: `${engine.policies.length} ${engine.policies.length === 1 ? "policy" : "policies"}`,
  }));
}

export function AddPolicyScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => <AddPolicyWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddPolicyWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const engines = project.spec.policyEngines ?? [];
  const [values, setValues] = useState<PolicyFormValues>({
    engine: engines[0]?.name ?? "",
    name: "",
    source: "inline",
    statement: "",
    statementFile: "",
    enforcement: "active",
  });
  const set = (update: Partial<PolicyFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        // Read the file at submit, the way `--statement file://…` does, so what
        // is written is what the file holds now, decoded strictly.
        const statement =
          values.source === "file"
            ? await readStatementFile(values.statementFile)
            : values.statement;
        const updated = yield* core.projectManager.addResource(
          project,
          toAddPolicyInput(toPolicyInput(values, statement)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding Policy ${values.name}…`}
      successLabel={`added Policy '${values.name}' to Policy Engine '${values.engine}' in '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="engine" prompt="which Policy Engine should this Policy belong to?">
        <ResourceChoiceField
          choices={engineChoices(engines)}
          value={values.engine}
          onChange={(engine) => set({ engine })}
          emptyMessage="no Policy Engines in this project"
          emptyHint="add one with  agentcore add policy-engine"
        />
      </Step>

      <Step stepKey="name" prompt="what should this Policy be called?">
        <TextField
          label="Policy name"
          help="letters, digits and underscores, starting with a letter (max 48) · unique across every Policy Engine in this project"
          placeholder="DenyAll"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={PolicyNameSchema}
          live
        />
      </Step>

      <Step stepKey="source" prompt="where is the Cedar statement?">
        <RevealChoiceField
          choices={SOURCE_CHOICES}
          value={values.source}
          onChange={(source) => set({ source })}
          input={{
            // Only a file needs a path, so it is asked under that row; pasting
            // continues to the editor on the next step.
            opensFor: (source) => source === "file",
            label: "Statement file",
            name: "statement file",
            help: "a .cedar file, relative to the current directory or absolute",
            placeholder: "policies/deny-all.cedar",
            value: values.statementFile,
            onChange: (statementFile) => set({ statementFile }),
            required: true,
            schema: readableFileSchema,
          }}
        />
      </Step>

      {values.source === "inline" && (
        <Step stepKey="statement" prompt="what is the Cedar statement?">
          <TextAreaField
            label="Cedar statement"
            help="type or paste the policy · enter for a new line, ctrl+d to continue"
            placeholder={STATEMENT_EXAMPLE}
            example={STATEMENT_EXAMPLE}
            value={values.statement}
            onChange={(statement) => set({ statement })}
            required
          />
        </Step>
      )}

      <Step stepKey="enforcement" prompt="should it enforce, or only log?">
        <ChoiceField
          choices={ENFORCEMENT_CHOICES}
          value={values.enforcement}
          onChange={(enforcement) => set({ enforcement })}
        />
      </Step>

      <Step stepKey="review" prompt="this Policy will be added to agentcore.json">
        <PolicyReview values={values} />
      </Step>
    </Wizard>
  );
}
