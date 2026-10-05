import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import z from "zod";
import {
  MultiTextField,
  ResourceChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import {
  RuntimeEndpointNameSchema,
  RuntimeEndpointSchema,
  type ProjectRuntime,
} from "../../../../projectSchemas/runtime";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import {
  DEFAULT_ENDPOINT_VERSION,
  toAddRuntimeEndpointInput,
  type RuntimeEndpointInput,
} from "./index";
import { RegionKey } from "../../../keys";

const BREADCRUMB = ["agentcore", "add", "runtime-endpoint"];
const DESCRIPTION = "add a named endpoint (version alias) to a runtime";
const ADD_MENU = "/agentcore/add";

// The version rule the spec applies, with a message that names the input; the
// whole-number check itself happens before the schema sees the value.
const VERSION_SCHEMA = z.number().int().min(1, "Version must be 1 or higher");

type RuntimeEndpointFormValues = {
  runtime: string;
  name: string;
  version: string;
  description: string;
};

// endpointNameSchema is the endpoint name rule plus the check the manager makes
// on submit — no two endpoints of one Runtime share a name — so a clash is
// caught as it is typed rather than after the review.
export function endpointNameSchema(runtime: ProjectRuntime | undefined): z.ZodType {
  const taken = new Set(Object.keys(runtime?.endpoints ?? {}));
  return RuntimeEndpointNameSchema.superRefine((name, ctx) => {
    if (runtime !== undefined && taken.has(name)) {
      ctx.addIssue({
        code: "custom",
        message: `an endpoint named '${name}' already exists on runtime '${runtime.name}'`,
      });
    }
  });
}

// toRuntimeEndpointInput is the answers as the flag path would state them: the
// version parsed from its digits, a blank description left out.
export function toRuntimeEndpointInput(values: RuntimeEndpointFormValues): RuntimeEndpointInput {
  const description = values.description.trim();
  return {
    runtime: values.runtime,
    name: values.name,
    version: Number(values.version),
    description: description === "" ? undefined : description,
  };
}

function summaryOf(values: RuntimeEndpointFormValues): Record<string, string> {
  return {
    runtime: values.runtime,
    endpoint: values.name,
    version: values.version,
    description: values.description.trim() || "(none)",
  };
}

// runtimeChoices lists each Runtime with the endpoints it already has, so the
// name step's uniqueness rule is no surprise.
function runtimeChoices(runtimes: readonly ProjectRuntime[]): Choice<string>[] {
  return runtimes.map((runtime) => {
    const names = Object.keys(runtime.endpoints ?? {});
    return {
      value: runtime.name,
      label: runtime.name,
      description:
        names.length === 0
          ? "no endpoints yet"
          : `${names.length === 1 ? "endpoint" : "endpoints"}: ${names.join(", ")}`,
    };
  });
}

export function AddRuntimeEndpointScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => (
        <AddRuntimeEndpointWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddRuntimeEndpointWizard({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  /** The command\'s resolved region, for the China gate of a project without targets. */
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runtimes = project.spec.runtimes;
  const [values, setValues] = useState<RuntimeEndpointFormValues>({
    runtime: runtimes[0]?.name ?? "",
    name: "",
    version: String(DEFAULT_ENDPOINT_VERSION),
    description: "",
  });
  const set = (update: Partial<RuntimeEndpointFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const runtime = runtimes.find((candidate) => candidate.name === values.runtime);

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddRuntimeEndpointInput(toRuntimeEndpointInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding runtime endpoint ${values.name}…`}
      successLabel={`added runtime endpoint '${values.name}' (version ${values.version}) to runtime '${values.runtime}' in '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="runtime" prompt="which Runtime should this endpoint belong to?">
        <ResourceChoiceField
          choices={runtimeChoices(runtimes)}
          value={values.runtime}
          onChange={(runtime) => set({ runtime })}
          emptyMessage="no Runtimes in this project"
          emptyHint="add one with  agentcore add runtime"
        />
      </Step>

      <Step stepKey="name" prompt="what should this endpoint be called?">
        <TextField
          label="Endpoint name"
          help="letters, digits and underscores, starting with a letter (max 48) · unique on this Runtime"
          placeholder="prod"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={endpointNameSchema(runtime)}
          live
        />
      </Step>

      <Step stepKey="details" prompt="which Runtime version does it point to?">
        <MultiTextField
          inputs={[
            {
              key: "version",
              label: "Version",
              help: `a whole number, 1 or higher · defaults to ${DEFAULT_ENDPOINT_VERSION}`,
              placeholder: String(DEFAULT_ENDPOINT_VERSION),
              value: values.version,
              onChange: (version) => set({ version }),
              required: true,
              number: true,
              schema: VERSION_SCHEMA,
            },
            {
              key: "description",
              label: "Description",
              help: "optional · up to 200 characters",
              placeholder: "production traffic",
              value: values.description,
              onChange: (description) => set({ description }),
              schema: RuntimeEndpointSchema.shape.description,
            },
          ]}
        />
      </Step>

      <Step stepKey="review" prompt="this endpoint will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
