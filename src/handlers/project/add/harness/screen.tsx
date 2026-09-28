import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import type z from "zod";
import { FormRadioGroup, type FormRadioOption } from "../../../../components/FormRadioGroup";
import { FormTextInput } from "../../../../components/FormTextInput";
import { darkTheme } from "../../../../components/ui/_core.js";
import {
  Step,
  Summary,
  TextAreaField,
  TextField,
  Wizard,
  useKeyHints,
  useWizard,
  type Choice,
} from "../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import {
  DEFAULT_HARNESS_MODEL,
  HarnessModelSchema,
  HarnessNameSchema,
  type HarnessSpecSchema,
} from "../../../../projectSchemas/harness";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { LoadingFrame, ProjectGate, projectQueryKey } from "../../ProjectGate";
import { requireDeployedNameFits } from "../shared";
import { toAddHarnessInput } from "./index";

const theme = darkTheme;
const BREADCRUMB = ["agentcore", "add", "harness"];
const DESCRIPTION = "add a harness to the current project";
const ADD_MENU = "/agentcore/add";

type HarnessSpecInput = z.input<typeof HarnessSpecSchema>;

// OTHER_MODEL is the list entry that reveals a text input for a Bedrock model
// or inference profile ID the list does not name.
const OTHER_MODEL = "other";

// The Bedrock IDs the CLI already names: the default every entry point shares
// first, then the ones its docs and help text use. Anything else is typed in.
const MODEL_CHOICES: Choice<string>[] = [
  {
    value: DEFAULT_HARNESS_MODEL.modelId,
    label: "Claude Sonnet 5 (default)",
    description: DEFAULT_HARNESS_MODEL.modelId,
  },
  {
    value: "global.anthropic.claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    description: "global.anthropic.claude-sonnet-4-6",
  },
  {
    value: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    label: "Claude Sonnet 4.5",
    description: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
  {
    value: OTHER_MODEL,
    label: "another Bedrock model",
    description: "type a model or inference profile ID",
  },
];

interface HarnessFormValues {
  name: string;
  systemPrompt: string;
  // The model list's answer. OTHER_MODEL means customModelId holds the ID.
  modelChoice: string;
  customModelId: string;
}

function modelIdOf(values: HarnessFormValues): string {
  return values.modelChoice === OTHER_MODEL ? values.customModelId.trim() : values.modelChoice;
}

// toHarnessInput is the answers as the flag path would state them: `--name`,
// `--model` with the shared Bedrock provider, `--system-prompt`. Everything
// else keeps the default it would have had, so a harness added here and one
// added with those three flags are the same harness.
export function toHarnessInput(values: HarnessFormValues): HarnessSpecInput {
  return {
    name: values.name,
    model: { provider: DEFAULT_HARNESS_MODEL.provider, modelId: modelIdOf(values) },
    systemPrompt: values.systemPrompt,
  };
}

// promptPreview keeps the review to one line: the prompt's first line, cut
// short, with a count of what follows it.
export function promptPreview(prompt: string): string {
  const lines = prompt.trim().split("\n");
  const first = lines[0] ?? "";
  const shown = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return lines.length > 1 ? `${shown} (+${lines.length - 1} more lines)` : shown;
}

function summaryOf(values: HarnessFormValues): Record<string, string> {
  return {
    harness: values.name,
    model: modelIdOf(values),
    "system prompt": promptPreview(values.systemPrompt),
  };
}

function targetsQueryKey(project: Project) {
  return ["project-targets", project.rootPath] as const;
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
      {(project) => <AddHarnessLoader project={project} core={core} />}
    </ProjectGate>
  );
}

function AddHarnessLoader({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const targets = useQuery({
    queryKey: targetsQueryKey(project),
    queryFn: () => core.projectManager.listTargets(project),
  });

  if (targets.data !== undefined) {
    return <AddHarnessWizard project={project} targets={targets.data} core={core} />;
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
}: {
  project: Project;
  targets: readonly AwsDeploymentTarget[];
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<HarnessFormValues>({
    name: "",
    systemPrompt: "",
    modelChoice: DEFAULT_HARNESS_MODEL.modelId,
    customModelId: "",
  });
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

      <Step stepKey="model" prompt="which model should it run on?">
        <ModelField
          modelChoice={values.modelChoice}
          customModelId={values.customModelId}
          onChange={(update) => set(update)}
        />
      </Step>

      <Step stepKey="review" prompt="this harness will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

function firstIssue(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  if (!issue) return "invalid value";
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

// ModelField is a compound field: one useInput over the model list and the
// text input the last entry reveals. The arrows move the value; enter continues
// with a listed model, or opens the input for one that is not listed, with esc
// or up stepping back out to the list.
function ModelField({
  modelChoice,
  customModelId,
  onChange,
}: {
  modelChoice: string;
  customModelId: string;
  onChange: (update: Partial<Pick<HarnessFormValues, "modelChoice" | "customModelId">>) => void;
}) {
  const { advance, back } = useWizard();
  const found = MODEL_CHOICES.findIndex((choice) => choice.value === modelChoice);
  const index = found === -1 ? 0 : found;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "enter", label: "continue" },
  ]);

  useInput((_input, key) => {
    if (!editing) {
      if (key.escape) {
        back();
        return;
      }
      if (key.upArrow || key.downArrow) {
        const nextIndex = key.upArrow
          ? Math.max(0, index - 1)
          : Math.min(MODEL_CHOICES.length - 1, index + 1);
        onChange({ modelChoice: MODEL_CHOICES[nextIndex]!.value });
        setError(undefined);
        return;
      }
      if (key.return) {
        if (modelChoice === OTHER_MODEL) setEditing(true);
        else advance();
      }
      return;
    }

    if (key.escape || key.upArrow) {
      setEditing(false);
      setError(undefined);
      return;
    }
    if (!key.return) return;

    // The same schema the flag path parses `--model` with, so an ID it would
    // refuse is refused here, in its words.
    const issue = firstIssue(HarnessModelSchema, {
      provider: DEFAULT_HARNESS_MODEL.provider,
      modelId: customModelId.trim(),
    });
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    setError(undefined);
    advance();
  });

  const options: FormRadioOption[] = MODEL_CHOICES.map(({ label, description }) => ({
    label,
    description: description ?? "",
  }));

  return (
    <Box flexDirection="column">
      <FormRadioGroup
        helpText=""
        options={options}
        focusedIndex={editing ? undefined : index}
        selectedIndex={index}
      />
      {editing && (
        <FormTextInput
          name="model ID"
          helpText="a Bedrock model ID or inference profile ID"
          placeholder="us.anthropic.claude-…"
          errorText=""
          value={customModelId}
          onChange={(value) => {
            onChange({ customModelId: value });
            setError(undefined);
          }}
        />
      )}
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}
