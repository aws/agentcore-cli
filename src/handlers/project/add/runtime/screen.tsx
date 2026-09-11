import { useState } from "react";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import {
  ProjectRuntimeSchema,
  RUNTIME_NAME_MAX_LENGTH,
  RuntimeNameSchema,
} from "../../../../projectSchemas/runtime";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
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

/** The template `add runtime` scaffolds when none is named, as on the flag path. */
const DEFAULT_TEMPLATE: RuntimeTemplateShortcutName = "agent-python-minimal";

// The default is listed first, so the step opens on its first row rather than
// partway down the list — the same place create's opens.
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
  description: string;
}

// toRuntimeInput reads the form into the RuntimeInput toAddRuntimeInput
// validates. The wizard scaffolds from a template and leaves the infrastructure
// settings — the role, network, authorizer and lifecycle configuration — at
// their defaults; those are JSON documents, so they stay on the flag path, as
// does importing a Bedrock Agent version.
export function toRuntimeInput(values: RuntimeFormValues): RuntimeInput {
  const name = values.name.trim();
  const description = values.description.trim();
  return {
    name,
    ...(description !== "" && { description }),
    envVars: [],
    scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(values.template, { runtimeName: name }),
  };
}

function summaryOf(values: RuntimeFormValues): Record<string, string> {
  const template = RUNTIME_TEMPLATE_SHORTCUTS[values.template];
  return {
    runtime: values.name.trim(),
    template: values.template,
    language: template.language,
    build: template.build,
    ...(values.description.trim() === "" ? {} : { description: values.description.trim() }),
  };
}

// AddRuntimeScreen is the interactive flow behind a bare `agentcore project add
// runtime`: name → template → description → review, then the add itself,
// streaming the ProjectManager's progress events.
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
  const [values, setValues] = useState<RuntimeFormValues>({
    name: "",
    template: DEFAULT_TEMPLATE,
    description: "",
  });
  const set = (update: Partial<RuntimeFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(project, toAddRuntimeInput(toRuntimeInput(values)))
      }
      runningLabel={`adding runtime ${values.name.trim()}…`}
      successLabel={`added runtime '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this runtime be called?">
        <TextField
          label="Name"
          help={`also the directory under app/ · letters, digits and underscores, starting with a letter (max ${RUNTIME_NAME_MAX_LENGTH})`}
          placeholder="my_agent"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={RuntimeNameSchema}
          live
        />
      </Step>

      <Step name="template" question="choose a template">
        <ChoiceField
          help="the agent code scaffolded into app/"
          choices={TEMPLATE_CHOICES}
          value={values.template}
          onChange={(template) => set({ template })}
        />
      </Step>

      <Step name="description" question="what is this runtime for? (optional)">
        <TextField
          label="description"
          placeholder="answers questions about orders"
          value={values.description}
          onChange={(description) => set({ description })}
          schema={ProjectRuntimeSchema.shape.description}
        />
      </Step>

      <Step name="review" question="this runtime will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
