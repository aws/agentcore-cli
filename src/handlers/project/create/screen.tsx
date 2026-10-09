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
import {
  createNextStep,
  DEFAULT_CREATE_RUNTIME_NAME,
  EMPTY_PROJECT_SUMMARY,
  emptyProjectCreatedMessage,
  emptyProjectNextSteps,
  resolveScaffoldHarnessInput,
} from "./index";
import { isChinaRegion } from "../../../core/partition";
import {
  HarnessModelField,
  emptyHarnessModel,
  harnessModelApiKeySource,
  harnessModelSummary,
  resolveHarnessModelApiKey,
  toHarnessModelInput,
  type HarnessModelValues,
} from "../HarnessModelField";
import {
  RuntimeModelField,
  emptyRuntimeModel,
  resolveRuntimeModelApiKey,
  runtimeModelSummary,
  toRuntimeModelOverrides,
  type RuntimeModelValues,
} from "../RuntimeModelField";
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
import { stripCreateRegionUnavailableDefaults, validateCreateRegionSupport } from "./region";

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
  // The code-based model step's answer; only read for templates that take a
  // model-provider override (see templateTakesModelProvider).
  runtimeModel: RuntimeModelValues;
}

function emptyCreateProjectForm(region?: string): CreateProjectFormValues {
  return {
    name: "",
    kind: "harness",
    model: emptyHarnessModel(),
    template: DEFAULT_TEMPLATE,
    runtimeModel: emptyRuntimeModel(region),
  };
}

// templateTakesModelProvider says whether the chosen template accepts the
// --model-provider/--model-id/--api-key overrides; the wizard asks the model
// step exactly when the flag path would accept those flags.
function templateTakesModelProvider(template: TemplateName): boolean {
  return (
    template !== EMPTY_TEMPLATE_NAME &&
    RUNTIME_TEMPLATE_SHORTCUTS[template].supportsModelProviderOverride
  );
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
// flag-driven path, including its existing API-key ARN support. apiKey is the
// chosen model step's key, already read from its file:// source.
export function buildCreateInput(
  values: CreateProjectFormValues,
  apiKey?: string,
): CreateProjectInput {
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
        "api-key": harnessModelApiKeySource(values.model),
        "api-base": model.apiBase,
      }),
      ...(apiKey !== undefined && { harnessApiKey: apiKey }),
    };
  }
  if (values.template === EMPTY_TEMPLATE_NAME) {
    return { name: values.name, skipInstall: false, skipGit: false };
  }
  const model = templateTakesModelProvider(values.template)
    ? toRuntimeModelOverrides(values.runtimeModel)
    : undefined;
  return {
    name: values.name,
    skipInstall: false,
    skipGit: false,
    scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(values.template, {
      runtimeName: DEFAULT_CREATE_RUNTIME_NAME,
      ...(model && {
        modelProvider: model.modelProvider,
        modelId: model.modelId,
        apiKey,
        apiBase: model.apiBase,
      }),
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
  return {
    ...base,
    type,
    template: values.template,
    ...(templateTakesModelProvider(values.template) && runtimeModelSummary(values.runtimeModel)),
    directory: `./${values.name}`,
  };
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
  const region = ctx.value(RegionKey);
  const [values, setValues] = useState<CreateProjectFormValues>(() =>
    emptyCreateProjectForm(region),
  );

  const patch = (update: Partial<CreateProjectFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const isEmptyProject = values.kind === "agent" && values.template === EMPTY_TEMPLATE_NAME;
  const china = region !== undefined && isChinaRegion(region);

  return (
    <Wizard
      breadcrumb={["agentcore", "create"]}
      description="create a new project"
      // Esc from the first step leaves the wizard for the root menu, the
      // same place RouterScreen's esc goes.
      onCancel={() => navigate("/agentcore")}
      onSubmit={async function* () {
        // All of these throw before anything is written, so the wizard reports
        // them the way it reports a failed create — with the retry still on
        // offer, because nothing has to be cleaned up first. The API key is
        // read here, at submit, the way the flag path reads --api-key.
        assertProjectPathFits(values.name, ctx.require(PlatformKey));
        const apiKey =
          values.kind === "harness"
            ? await resolveHarnessModelApiKey(values.model)
            : templateTakesModelProvider(values.template)
              ? await resolveRuntimeModelApiKey(toRuntimeModelOverrides(values.runtimeModel))
              : undefined;
        const input = buildCreateInput(values, apiKey);
        const resolvedRegion = ctx.require(RegionKey);
        validateCreateRegionSupport(input, resolvedRegion);
        const stripped = stripCreateRegionUnavailableDefaults(input, resolvedRegion);
        if (stripped !== undefined) yield { type: "step" as const, message: stripped };
        return yield* core.projectManager.create(input);
      }}
      runningLabel={`creating ${values.name}…`}
      successLabel={
        isEmptyProject
          ? `empty project created in ./${values.name}. ${EMPTY_PROJECT_SUMMARY}`
          : `project created in ./${values.name}`
      }
      successNextSteps={
        isEmptyProject
          ? emptyProjectNextSteps(values.name, china)
          : [`cd ${values.name}`, createNextStep(values.kind === "agent")]
      }
      successHint="enter exits"
      onDone={() => {
        ctx.value(TuiExitMessageKey)?.(
          isEmptyProject
            ? emptyProjectCreatedMessage(values.name, china).trimEnd()
            : `Next step:\n  cd ${values.name}/ && agentcore`,
        );
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

      {values.kind === "agent" && templateTakesModelProvider(values.template) && (
        <Step stepKey="runtimeModel" title="model provider">
          <RuntimeModelField
            value={values.runtimeModel}
            onChange={(runtimeModel) => patch({ runtimeModel })}
            region={region}
            language={
              values.template === EMPTY_TEMPLATE_NAME
                ? undefined
                : RUNTIME_TEMPLATE_SHORTCUTS[values.template].language
            }
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
