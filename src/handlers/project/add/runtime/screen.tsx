import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
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

const BREADCRUMB = ["agentcore", "project", "add", "runtime"];
const DESCRIPTION = "add a Runtime to the current project";
const ADD_MENU = "/agentcore/project/add";

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
}

export function toRuntimeInput(values: RuntimeFormValues): RuntimeInput {
  return {
    name: values.name,
    envVars: [],
    scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(values.template, {
      runtimeName: values.name,
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
      {(project) => <AddRuntimeWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddRuntimeWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<RuntimeFormValues>({
    name: "",
    template: DEFAULT_TEMPLATE,
  });
  const set = (update: Partial<RuntimeFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddRuntimeInput(toRuntimeInput(values)),
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
        <ChoiceField
          help="the agent code scaffolded into app/"
          choices={TEMPLATE_CHOICES}
          value={values.template}
          onChange={(template) => set({ template })}
        />
      </Step>

      <Step stepKey="review" prompt="this runtime will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
