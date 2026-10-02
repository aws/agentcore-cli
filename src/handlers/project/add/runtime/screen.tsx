import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import { RegionKey } from "../../../keys";
import { AgentNameSchema } from "../../../../projectSchemas/runtime";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import {
  ChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import {
  RUNTIME_TEMPLATE_SHORTCUTS,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../shortcuts";
import { toAddRuntimeInput, type RuntimeInput } from "./index";
import {
  RuntimeModelField,
  emptyRuntimeModel,
  resolveRuntimeModelApiKey,
  runtimeModelSummary,
  toRuntimeModelOverrides,
  type RuntimeModelValues,
} from "../../RuntimeModelField";

const BREADCRUMB = ["agentcore", "add", "runtime"];
const DESCRIPTION = "add a Runtime to the current project";
const ADD_MENU = "/agentcore/add";

const DEFAULT_TEMPLATE: RuntimeTemplateShortcutName = "agent-python-minimal";

const TEMPLATE_CHOICES: Choice<RuntimeTemplateShortcutName>[] = [
  DEFAULT_TEMPLATE,
  ...RUNTIME_TEMPLATE_SHORTCUT_NAMES.filter((template) => template !== DEFAULT_TEMPLATE),
].map((template) => ({
  value: template,
  label: template,
  description: RUNTIME_TEMPLATE_SHORTCUTS[template].description,
}));

interface RuntimeFormValues {
  name: string;
  template: RuntimeTemplateShortcutName;
  // The model step's answer; only read for templates that take a
  // model-provider override (see templateTakesModelProvider).
  model: RuntimeModelValues;
}

// templateTakesModelProvider says whether the chosen template accepts the
// --model-provider/--model-id/--api-key overrides; the wizard asks the model
// step exactly when the flag path would accept those flags.
function templateTakesModelProvider(template: RuntimeTemplateShortcutName): boolean {
  return RUNTIME_TEMPLATE_SHORTCUTS[template].supportsModelProviderOverride;
}

// toRuntimeInput builds the runtime the way the flag handler does for
// `--template <t> [--model-provider … --model-id … --api-key …]`; apiKey is
// the model step's key, already read from its file:// source.
export function toRuntimeInput(values: RuntimeFormValues, apiKey?: string): RuntimeInput {
  const model = templateTakesModelProvider(values.template)
    ? toRuntimeModelOverrides(values.model)
    : undefined;
  return {
    name: values.name,
    envVars: [],
    scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(values.template, {
      runtimeName: values.name,
      ...(model && { modelProvider: model.modelProvider, modelId: model.modelId, apiKey }),
    }),
  };
}

function summaryOf(values: RuntimeFormValues): Record<string, string> {
  const template = RUNTIME_TEMPLATE_SHORTCUTS[values.template];
  return {
    runtime: values.name,
    template: values.template,
    language: template.language,
    build: template.build,
    ...(templateTakesModelProvider(values.template) && runtimeModelSummary(values.model)),
  };
}

export function AddRuntimeScreen({ ctx, core }: ScreenProps) {
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
        <AddRuntimeWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddRuntimeWizard({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  /** The command's resolved region; a China region shapes the model step. */
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<RuntimeFormValues>(() => ({
    name: "",
    template: DEFAULT_TEMPLATE,
    model: emptyRuntimeModel(region),
  }));
  const set = (update: Partial<RuntimeFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        // The API key is read here, at submit, the way the flag path reads
        // --api-key; it throws before anything is written.
        const apiKey = templateTakesModelProvider(values.template)
          ? await resolveRuntimeModelApiKey(toRuntimeModelOverrides(values.model))
          : undefined;
        const updated = yield* core.projectManager.addResource(
          project,
          toAddRuntimeInput(toRuntimeInput(values, apiKey)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding runtime ${values.name}…`}
      successLabel={`added runtime '${values.name}' to '${project.name}'`}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this runtime be called?">
        <TextField
          label="Name"
          help="also the directory under app/ · letters, digits and underscores, starting with a letter (max 48)"
          placeholder="my_agent"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={AgentNameSchema}
          live
        />
      </Step>

      <Step stepKey="template" prompt="choose a template">
        <ChoiceField<RuntimeTemplateShortcutName>
          help="the agent code scaffolded into app/"
          choices={TEMPLATE_CHOICES}
          value={values.template}
          onChange={(template) => set({ template })}
        />
      </Step>

      {templateTakesModelProvider(values.template) && (
        <Step stepKey="model" title="model provider">
          <RuntimeModelField
            value={values.model}
            onChange={(model) => set({ model })}
            region={region}
          />
        </Step>
      )}

      <Step stepKey="review" prompt="this runtime will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
