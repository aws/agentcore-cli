import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type z from "zod";
import {
  promptPreview,
  Step,
  Summary,
  TextAreaField,
  TextField,
  Wizard,
} from "../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import { HarnessNameSchema, type HarnessSpecSchema } from "../../../../projectSchemas/harness";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import {
  HarnessModelField,
  emptyHarnessModel,
  harnessModelSummary,
  toHarnessModelInput,
  type HarnessModelValues,
} from "../../HarnessModelField";
import { LoadingFrame, ProjectGate, projectQueryKey, useProjectTargets } from "../../ProjectGate";
import { requireDeployedNameFits } from "../shared";
import { toAddHarnessInput } from "./index";
import { RegionKey } from "../../../keys";

const BREADCRUMB = ["agentcore", "add", "harness"];
const DESCRIPTION = "add a harness to the current project";
const ADD_MENU = "/agentcore/add";

type HarnessSpecInput = z.input<typeof HarnessSpecSchema>;

interface HarnessFormValues {
  name: string;
  systemPrompt: string;
  // The model step is the one `agentcore create` asks for a config-based
  // project, so a harness added here and one a project starts with are
  // configured the same way.
  model: HarnessModelValues;
}

// toHarnessInput is the answers as the flag path would state them: `--name`,
// `--model`, `--system-prompt`. Everything else keeps the default it would
// have had, so a harness added here and one added with those three flags are
// the same harness.
export function toHarnessInput(values: HarnessFormValues): HarnessSpecInput {
  return {
    name: values.name,
    model: toHarnessModelInput(values.model),
    systemPrompt: values.systemPrompt,
  };
}

function summaryOf(values: HarnessFormValues): Record<string, string> {
  return {
    harness: values.name,
    ...harnessModelSummary(values.model),
    "system prompt": promptPreview(values.systemPrompt),
  };
}

export function AddHarnessScreen({ ctx, core }: ScreenProps) {
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
        <AddHarnessLoader project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddHarnessLoader({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const targets = useProjectTargets(core, project);

  if (targets.data !== undefined) {
    return (
      <AddHarnessWizard project={project} targets={targets.data} core={core} region={region} />
    );
  }

  return (
    <LoadingFrame
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      query={targets}
      loadingLabel="loading deployment targets…"
      onBack={() => navigate(ADD_MENU)}
    />
  );
}

function AddHarnessWizard({
  project,
  targets,
  core,
  region,
}: {
  project: Project;
  targets: readonly AwsDeploymentTarget[];
  core: ScreenProps["core"];
  /** The command\'s resolved region, for the China gate of a project without targets. */
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<HarnessFormValues>(() => ({
    name: "",
    systemPrompt: "",
    model: emptyHarnessModel(),
  }));
  const set = (update: Partial<HarnessFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  // The deployed name is <project>_<target>_<name> and must fit the service
  // cap, so the live check reports the real budget rather than the schema's 40.
  const nameSchema = useMemo(
    () =>
      HarnessNameSchema.superRefine((name, ctx) => {
        try {
          requireDeployedNameFits("Harness", project.name, name, "_", 40, targets);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    [project.name, targets],
  );

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddHarnessInput(project, targets, toHarnessInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding harness ${values.name}…`}
      successLabel={`added harness '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this harness be called?">
        <TextField
          label="Name"
          help="also the directory under app/ · letters, digits and underscores, starting with a letter; the deployed <project>_<target>_<name> must fit 40 characters"
          placeholder="assistant"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      <Step stepKey="prompt" prompt="what is the agent's system prompt?">
        <TextAreaField
          label="System prompt"
          help="type or paste the agent's instructions · enter for a new line, ctrl+d to continue"
          placeholder="You are a helpful assistant…"
          value={values.systemPrompt}
          onChange={(systemPrompt) => set({ systemPrompt })}
          required
        />
      </Step>

      <Step stepKey="model" title="model provider">
        <HarnessModelField value={values.model} onChange={(model) => set({ model })} />
      </Step>

      <Step stepKey="review" prompt="this harness will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
