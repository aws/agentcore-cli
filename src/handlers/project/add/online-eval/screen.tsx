import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import z from "zod";
import { FormCheckboxMultiSelect } from "../../../../components/FormCheckboxMultiSelect";
import { FormTextInput } from "../../../../components/FormTextInput";
import { darkTheme } from "../../../../components/ui/_core.js";
import {
  Step,
  Summary,
  TextField,
  Wizard,
  useKeyHints,
  useWizard,
  type Choice,
} from "../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import {
  ONLINE_EVAL_MAX_EVALUATORS,
  OnlineEvalConfigNameSchema,
  OnlineEvalEvaluatorsSchema,
} from "../../../../projectSchemas/online-eval-config";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import { LoadingFrame, ProjectGate, projectQueryKey, useProjectTargets } from "../../ProjectGate";
import type { Project } from "../../types";
import { requireDeployedNameFits } from "../shared";
import {
  initialTrafficSourceValues,
  splitCommaList,
  toTrafficSourceInput,
  trafficSourceSteps,
  trafficSourceSummary,
  type TrafficSourceFormValues,
} from "../traffic-source-fields";
import {
  ONLINE_EVAL_DEPLOYED_NAME_MAX_LENGTH,
  toAddOnlineEvalInput,
  validateEvaluatorReferences,
  type OnlineEvalInput,
} from "./index";
import { RegionKey } from "../../../keys";

const theme = darkTheme;
const BREADCRUMB = ["agentcore", "add", "online-eval"];
const DESCRIPTION = "add an online evaluation config to the current project";
const ADD_MENU = "/agentcore/add";
const CUSTOM_EVALUATORS = Symbol("custom evaluators");

const BUILTIN_EVALUATOR_CHOICES: Choice<string>[] = [
  {
    value: "Builtin.Correctness",
    label: "Builtin.Correctness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Faithfulness",
    label: "Builtin.Faithfulness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Helpfulness",
    label: "Builtin.Helpfulness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.ResponseRelevance",
    label: "Builtin.ResponseRelevance",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Conciseness",
    label: "Builtin.Conciseness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Coherence",
    label: "Builtin.Coherence",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.InstructionFollowing",
    label: "Builtin.InstructionFollowing",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Refusal",
    label: "Builtin.Refusal",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.GoalSuccessRate",
    label: "Builtin.GoalSuccessRate",
    description: "SESSION evaluator",
  },
  {
    value: "Builtin.ToolSelectionAccuracy",
    label: "Builtin.ToolSelectionAccuracy",
    description: "TOOL_CALL evaluator",
  },
  {
    value: "Builtin.ToolParameterAccuracy",
    label: "Builtin.ToolParameterAccuracy",
    description: "TOOL_CALL evaluator",
  },
  {
    value: "Builtin.Harmfulness",
    label: "Builtin.Harmfulness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Stereotyping",
    label: "Builtin.Stereotyping",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.TrajectoryExactOrderMatch",
    label: "Builtin.TrajectoryExactOrderMatch",
    description: "SESSION evaluator",
  },
  {
    value: "Builtin.TrajectoryInOrderMatch",
    label: "Builtin.TrajectoryInOrderMatch",
    description: "SESSION evaluator",
  },
  {
    value: "Builtin.TrajectoryAnyOrderMatch",
    label: "Builtin.TrajectoryAnyOrderMatch",
    description: "SESSION evaluator",
  },
];

interface OnlineEvalFormValues extends TrafficSourceFormValues {
  name: string;
  evaluators: string[];
  includeCustomEvaluators: boolean;
  customEvaluators: string;
  samplingRate: string;
}

function firstError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function evaluatorsOf(values: OnlineEvalFormValues): string[] {
  return unique([
    ...values.evaluators,
    ...(values.includeCustomEvaluators ? splitCommaList(values.customEvaluators) : []),
  ]);
}

function evaluatorLimitIssue(evaluators: readonly string[]): string | undefined {
  const result = OnlineEvalEvaluatorsSchema.safeParse(evaluators);
  return result.success ? undefined : result.error.issues[0]?.message;
}

export function toOnlineEvalInput(values: OnlineEvalFormValues): OnlineEvalInput {
  return {
    name: values.name,
    ...toTrafficSourceInput(values),
    evaluators: evaluatorsOf(values),
    samplingRate: Number(values.samplingRate),
  };
}

function summaryOf(values: OnlineEvalFormValues): Record<string, string> {
  return {
    config: values.name,
    ...trafficSourceSummary(values),
    evaluators: evaluatorsOf(values).join(", "),
    sampling: `${values.samplingRate}%`,
  };
}

export function AddOnlineEvalScreen({ ctx, core }: ScreenProps) {
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
        <AddOnlineEvalLoader project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddOnlineEvalLoader({
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
      <AddOnlineEvalWizard project={project} targets={targets.data} core={core} region={region} />
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

function AddOnlineEvalWizard({
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
  const runtimes = project.spec.runtimes;
  const initialRuntime = runtimes[0]?.name ?? "";
  const [values, setValues] = useState<OnlineEvalFormValues>({
    ...initialTrafficSourceValues(initialRuntime),
    name: "",
    evaluators: [],
    includeCustomEvaluators: false,
    customEvaluators: "",
    samplingRate: "",
  });
  const set = (update: Partial<OnlineEvalFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const evaluatorChoices: Choice<string>[] = [
    ...project.spec.evaluators.map((evaluator) => ({
      value: evaluator.name,
      label: evaluator.name,
      description: `${evaluator.level} project evaluator`,
    })),
    ...BUILTIN_EVALUATOR_CHOICES,
  ];

  const nameSchema = useMemo(
    () =>
      OnlineEvalConfigNameSchema.superRefine((name, ctx) => {
        try {
          requireDeployedNameFits(
            "Online-eval config",
            project.name,
            name,
            "_",
            ONLINE_EVAL_DEPLOYED_NAME_MAX_LENGTH,
            targets,
          );
        } catch (error) {
          ctx.addIssue({ code: "custom", message: firstError(error) });
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
          toAddOnlineEvalInput(project, targets, toOnlineEvalInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding online evaluation config ${values.name}…`}
      successLabel={`added online-eval config '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this online evaluation config be called?">
        <TextField
          label="Name"
          help="letters, digits and underscores, starting with a letter; the deployed <project>_<target>_<name> must fit 48 characters"
          placeholder="production_quality"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      {trafficSourceSteps({ values, runtimes, onChange: set })}

      <Step stepKey="evaluators" prompt="which evaluators should score it?">
        <EvaluatorSelectionField
          project={project}
          choices={evaluatorChoices}
          evaluators={values.evaluators}
          includeCustomEvaluators={values.includeCustomEvaluators}
          customEvaluators={values.customEvaluators}
          onChange={(update) => set(update)}
        />
      </Step>

      <Step stepKey="sampling" prompt="what percentage of sessions should be sampled?">
        <TextField
          label="Sampling rate"
          help="a percentage from 0.01 through 100"
          placeholder="10"
          value={values.samplingRate}
          onChange={(samplingRate) => set({ samplingRate })}
          required
          decimal
          schema={z.number().min(0.01).max(100)}
        />
      </Step>

      <Step stepKey="review" prompt="this online evaluation config will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

type EvaluatorSelectionUpdate = Partial<
  Pick<OnlineEvalFormValues, "evaluators" | "includeCustomEvaluators" | "customEvaluators">
>;

function EvaluatorSelectionField({
  project,
  choices,
  evaluators,
  includeCustomEvaluators,
  customEvaluators,
  onChange,
}: {
  project: Project;
  choices: Choice<string>[];
  evaluators: string[];
  includeCustomEvaluators: boolean;
  customEvaluators: string;
  onChange: (update: EvaluatorSelectionUpdate) => void;
}) {
  const { advance, back } = useWizard();
  const [cursor, setCursor] = useState(0);
  const [customFocused, setCustomFocused] = useState(false);
  const [error, setError] = useState<string>();
  const allChoices: Choice<string | typeof CUSTOM_EVALUATORS>[] = [
    ...choices,
    {
      value: CUSTOM_EVALUATORS,
      label: "Custom evaluator IDs or ARNs",
      description: "enter additional Builtin.* identifiers or evaluator ARNs",
    },
  ];

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "space", label: "toggle" },
    { key: "enter", label: "continue" },
  ]);

  useInput((input, key) => {
    if (customFocused) {
      if (key.escape || key.upArrow) {
        setCustomFocused(false);
        setError(undefined);
        return;
      }
      if (!key.return) return;

      const custom = splitCommaList(customEvaluators);
      if (custom.length === 0) {
        setError("At least one custom evaluator ID or ARN is required");
        return;
      }
      try {
        validateEvaluatorReferences(project, custom);
      } catch (validationError) {
        setError(firstError(validationError));
        return;
      }

      const limitIssue = evaluatorLimitIssue(unique([...evaluators, ...custom]));
      if (limitIssue !== undefined) {
        setError(limitIssue);
        return;
      }

      setError(undefined);
      advance();
      return;
    }

    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => Math.min(allChoices.length - 1, current + 1));
      return;
    }
    if (input === " ") {
      const selected = allChoices[cursor]!.value;
      if (selected === CUSTOM_EVALUATORS) {
        if (!includeCustomEvaluators && evaluators.length >= ONLINE_EVAL_MAX_EVALUATORS) {
          setError("At most 10 evaluators may be selected");
          return;
        }
        onChange({ includeCustomEvaluators: !includeCustomEvaluators });
        setError(undefined);
        return;
      }

      const toggled = evaluators.includes(selected)
        ? evaluators.filter((evaluator) => evaluator !== selected)
        : [...evaluators, selected];
      const combined = unique([
        ...toggled,
        ...(includeCustomEvaluators ? splitCommaList(customEvaluators) : []),
      ]);
      const limitIssue = evaluatorLimitIssue(combined);
      if (limitIssue !== undefined) {
        setError(limitIssue);
        return;
      }

      onChange({
        evaluators: choices
          .filter((choice) => toggled.includes(choice.value))
          .map((choice) => choice.value),
      });
      setError(undefined);
      return;
    }
    if (!key.return) return;

    if (evaluators.length === 0 && !includeCustomEvaluators) {
      setError("Select at least one evaluator");
      return;
    }
    if (includeCustomEvaluators) {
      setCustomFocused(true);
      setError(undefined);
      return;
    }

    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      <FormCheckboxMultiSelect
        name=""
        helpText="select up to 10 project, built-in, or custom evaluators"
        options={allChoices.map((choice) => ({
          label: choice.label,
          description: choice.description ?? "",
          checked:
            choice.value === CUSTOM_EVALUATORS
              ? includeCustomEvaluators
              : evaluators.includes(choice.value),
        }))}
        cursorIndex={customFocused ? -1 : cursor}
      />
      {includeCustomEvaluators && (
        <FormTextInput
          name="Custom evaluator IDs or ARNs"
          helpText="comma-separated Builtin.* identifiers or evaluator ARNs"
          placeholder="Builtin.Helpfulness, arn:aws:bedrock-agentcore:..."
          errorText=""
          value={customEvaluators}
          onChange={(value) => {
            onChange({ customEvaluators: value });
            setError(undefined);
          }}
          focused={customFocused}
        />
      )}
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}
