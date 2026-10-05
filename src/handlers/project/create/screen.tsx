import { useState } from "react";
import { Box, Text, useApp } from "ink";
import { useNavigate } from "react-router";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import type { ScreenProps } from "../../types";
import { PlatformKey } from "../../../router";
import { RegionKey } from "../../keys";
import { assertProjectPathFits } from "./pathLimit";
import type { CreateProjectInput } from "../types";
import {
  EMPTY_TEMPLATE_NAME,
  PROJECT_TEMPLATE_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
  resolveRuntimeTemplateShortcut,
  type TemplateName,
} from "../shortcuts";
import { createNextStep, DEFAULT_CREATE_RUNTIME_NAME, resolveScaffoldHarnessInput } from "./index";
import {
  HarnessModelField,
  emptyHarnessModel,
  harnessModelSummary,
  toHarnessModelInput,
  type HarnessModelValues,
} from "../HarnessModelField";
import {
  ChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../components/wizard";
import { darkTheme } from "../../../components/ui/_core.js";
import { TuiExitMessageKey } from "../../../tui/exitMessage";
import { validateCreateRegionSupport } from "./region";

const theme = darkTheme;

// ─── form model ───────────────────────────────────────────────────────────────

// ProjectKind mirrors the headless dispatch: a project is created around either
// a harness (the default) or scaffolded runtime code.
type ProjectKind = "harness" | "agent";

interface CreateProjectFormValues {
  name: string;
  kind: ProjectKind;
  model: HarnessModelValues;
  template: TemplateName;
}

function emptyCreateProjectForm(): CreateProjectFormValues {
  return {
    name: "",
    kind: "harness",
    model: emptyHarnessModel(),
    template: DEFAULT_TEMPLATE,
  };
}

const PROJECT_KIND_CHOICES: Choice<ProjectKind>[] = [
  {
    value: "harness",
    label: "config-based",
    description: "define a managed agent in config: pick a model, prompt, and tools",
  },
  {
    value: "agent",
    label: "code-based",
    description: "write your own agent with an SDK like Strands or LangGraph, hosted on Runtime",
  },
];

const DEFAULT_TEMPLATE: TemplateName = "agent-python-strands";

const TEMPLATE_CHOICES: Choice<TemplateName>[] = PROJECT_TEMPLATE_NAMES.map((template) => ({
  value: template,
  label: template,
  description:
    template === EMPTY_TEMPLATE_NAME
      ? "an empty project with no runtime or harness"
      : RUNTIME_TEMPLATE_SHORTCUTS[template].description,
}));

// buildCreateInput translates the form through the same resolver as the
// flag-driven path, including its existing API-key ARN support.
export function buildCreateInput(values: CreateProjectFormValues): CreateProjectInput {
  if (values.kind === "harness") {
    const model = toHarnessModelInput(values.model);
    return {
      name: values.name,
      skipInstall: false,
      skipGit: false,
      scaffoldHarnessInput: resolveScaffoldHarnessInput({
        name: values.name,
        "model-provider": model.provider,
        "model-id": model.modelId,
        "api-key-arn": model.apiKeyArn,
        "api-base": model.apiBase,
      }),
    };
  }
  if (values.template === EMPTY_TEMPLATE_NAME) {
    return { name: values.name, skipInstall: false, skipGit: false };
  }
  return {
    name: values.name,
    skipInstall: false,
    skipGit: false,
    scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(values.template, {
      runtimeName: DEFAULT_CREATE_RUNTIME_NAME,
    }),
  };
}

// summaryOf renders the review table: what will be created, and where.
function summaryOf(values: CreateProjectFormValues): Record<string, string> {
  const base = { project: values.name };
  if (values.kind === "harness") {
    return {
      ...base,
      type: "harness",
      ...harnessModelSummary(values.model),
      directory: `./${values.name}`,
    };
  }
  const type = values.template === EMPTY_TEMPLATE_NAME ? "empty project" : "agent code";
  return { ...base, type, template: values.template, directory: `./${values.name}` };
}

// ─── wizard ───────────────────────────────────────────────────────────────────

// ProjectCreateScreen is the interactive flow behind a bare `agentcore
// create`: name → type → (model | template) → review, then the
// creation itself, streaming the ProjectManager's progress events. It drives
// core.projectManager.create with the same input the flag-driven handler
// builds, so both entry points scaffold identical projects — in the current
// working directory, npm install and git init included.
export function ProjectCreateScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  const { exit } = useApp();
  const [values, setValues] = useState<CreateProjectFormValues>(emptyCreateProjectForm);

  const patch = (update: Partial<CreateProjectFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={["agentcore", "create"]}
      description="create a new project"
      // Esc from the first step leaves the wizard for the root menu, the
      // same place RouterScreen's esc goes.
      onCancel={() => navigate("/agentcore")}
      onSubmit={() => {
        // Both of these throw before anything is written, so the wizard reports
        // them the way it reports a failed create — with the retry still on
        // offer, because nothing has to be cleaned up first.
        assertProjectPathFits(values.name, ctx.require(PlatformKey));
        const input = buildCreateInput(values);
        validateCreateRegionSupport(input, ctx.require(RegionKey));
        return core.projectManager.create(input);
      }}
      runningLabel={`creating ${values.name}…`}
      successLabel={`project created in ./${values.name}`}
      successNextSteps={[
        `cd ${values.name}`,
        createNextStep(values.kind === "agent" && values.template !== EMPTY_TEMPLATE_NAME),
      ]}
      successHint="enter exits"
      onDone={() => {
        ctx.value(TuiExitMessageKey)?.(`Next step:\n  cd ${values.name}/ && agentcore`);
        exit();
      }}
      doneLabel="exit"
    >
      <Step stepKey="name" prompt="name your project">
        {/* The label is the schema's own subject, so a blank name is refused
            with the message the flag-driven path prints for it. */}
        <TextField
          label="Project name"
          help="also the directory name · 1–23 letters and digits, starting with a letter"
          placeholder="MyAssistant"
          value={values.name}
          onChange={(name) => patch({ name })}
          schema={ProjectNameSchema}
          required
          live
        />
      </Step>

      <Step stepKey="type" prompt="what kind of agent to start with?">
        <ChoiceField
          choices={PROJECT_KIND_CHOICES}
          value={values.kind}
          onChange={(kind) => patch({ kind })}
        />
      </Step>

      {values.kind === "harness" && (
        <Step stepKey="model" title="model provider">
          <HarnessModelField value={values.model} onChange={(model) => patch({ model })} />
        </Step>
      )}

      {values.kind === "agent" && (
        <Step stepKey="template" prompt="choose a template">
          <ChoiceField<TemplateName>
            choices={TEMPLATE_CHOICES}
            value={values.template}
            onChange={(template) => patch({ template })}
          />
        </Step>
      )}

      <Step stepKey="review" prompt="this project will be created">
        <Summary items={summaryOf(values)} />
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            enter scaffolds the project, installs dependencies, and initializes git
          </Text>
        </Box>
      </Step>
    </Wizard>
  );
}
