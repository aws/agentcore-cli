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
import { OnlineEvalConfigNameSchema } from "../../../../projectSchemas/online-eval-config";
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
  ONLINE_INSIGHT_DEPLOYED_NAME_MAX_LENGTH,
  toAddOnlineInsightInput,
  type OnlineInsightInput,
} from "./index";
import { RegionKey } from "../../../keys";

const theme = darkTheme;
const BREADCRUMB = ["agentcore", "add", "online-insight"];
const DESCRIPTION = "add an online insight config to the current project";
const ADD_MENU = "/agentcore/add";

type ClusteringFrequency = "DAILY" | "WEEKLY" | "MONTHLY";
const CUSTOM_INSIGHT = "CUSTOM";

const BUILTIN_INSIGHT_CHOICES: Choice<string>[] = [
  {
    value: "Builtin.Insight.FailureAnalysis",
    label: "FailureAnalysis",
    description: "identify and explain failed sessions",
  },
  {
    value: "Builtin.Insight.UserIntent",
    label: "UserIntent",
    description: "group sessions by what users are trying to accomplish",
  },
  {
    value: "Builtin.Insight.ExecutionSummary",
    label: "ExecutionSummary",
    description: "summarize how sessions execute",
  },
];

const INSIGHT_CHOICES: Choice<string>[] = [
  ...BUILTIN_INSIGHT_CHOICES,
  {
    value: CUSTOM_INSIGHT,
    label: "Custom insight ARN",
    description: "use an insight defined outside the built-in set",
  },
];

const CLUSTERING_CHOICES: Choice<ClusteringFrequency>[] = [
  { value: "DAILY", label: "DAILY" },
  { value: "WEEKLY", label: "WEEKLY" },
  { value: "MONTHLY", label: "MONTHLY" },
];

interface OnlineInsightFormValues extends TrafficSourceFormValues {
  name: string;
  builtinInsights: string[];
  includeCustomInsight: boolean;
  customInsights: string;
  clusteringFrequencies: ClusteringFrequency[];
  samplingRate: string;
  description: string;
}

function insightsOf(values: OnlineInsightFormValues): string[] {
  return [
    ...values.builtinInsights,
    ...(values.includeCustomInsight ? splitCommaList(values.customInsights) : []),
  ];
}

export function toOnlineInsightInput(values: OnlineInsightFormValues): OnlineInsightInput {
  return {
    name: values.name,
    ...toTrafficSourceInput(values),
    insights: insightsOf(values),
    clusteringFrequencies:
      values.clusteringFrequencies.length === 0 ? undefined : values.clusteringFrequencies,
    samplingRate: Number(values.samplingRate),
    description: values.description === "" ? undefined : values.description,
  };
}

function summaryOf(values: OnlineInsightFormValues): Record<string, string> {
  return {
    config: values.name,
    ...trafficSourceSummary(values),
    insights: insightsOf(values).join(", "),
    clustering:
      values.clusteringFrequencies.length === 0
        ? "(none)"
        : values.clusteringFrequencies.join(", "),
    sampling: `${values.samplingRate}%`,
    description: values.description === "" ? "(none)" : values.description,
  };
}

export function AddOnlineInsightScreen({ ctx, core }: ScreenProps) {
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
        <AddOnlineInsightLoader project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddOnlineInsightLoader({
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
      <AddOnlineInsightWizard
        project={project}
        targets={targets.data}
        core={core}
        region={region}
      />
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

function AddOnlineInsightWizard({
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
  const [values, setValues] = useState<OnlineInsightFormValues>({
    ...initialTrafficSourceValues(initialRuntime),
    name: "",
    builtinInsights: [],
    includeCustomInsight: false,
    customInsights: "",
    clusteringFrequencies: [],
    samplingRate: "",
    description: "",
  });
  const set = (update: Partial<OnlineInsightFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const nameSchema = useMemo(
    () =>
      OnlineEvalConfigNameSchema.superRefine((name, ctx) => {
        try {
          requireDeployedNameFits(
            "Online insight config",
            project.name,
            name,
            "_",
            ONLINE_INSIGHT_DEPLOYED_NAME_MAX_LENGTH,
            targets,
          );
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
          toAddOnlineInsightInput(project, targets, toOnlineInsightInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding online insight config ${values.name}…`}
      successLabel={`added online-insight config '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this online insight config be called?">
        <TextField
          label="Name"
          help="letters, digits and underscores, starting with a letter; the deployed <project>_<target>_<name> must fit 48 characters"
          placeholder="production_insights"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      {trafficSourceSteps({ values, runtimes, onChange: set })}

      <Step stepKey="insights" prompt="which insights should run?">
        <InsightSelectionField
          builtinInsights={values.builtinInsights}
          includeCustomInsight={values.includeCustomInsight}
          customInsights={values.customInsights}
          onChange={(update) => set(update)}
        />
      </Step>

      <Step stepKey="settings" prompt="how should insight sessions be sampled and clustered?">
        <InsightSettingsField
          clusteringFrequencies={values.clusteringFrequencies}
          samplingRate={values.samplingRate}
          description={values.description}
          onChange={(update) => set(update)}
        />
      </Step>

      <Step stepKey="review" prompt="this online insight config will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

type InsightSelectionUpdate = Partial<
  Pick<OnlineInsightFormValues, "builtinInsights" | "includeCustomInsight" | "customInsights">
>;

function InsightSelectionField({
  builtinInsights,
  includeCustomInsight,
  customInsights,
  onChange,
}: {
  builtinInsights: string[];
  includeCustomInsight: boolean;
  customInsights: string;
  onChange: (update: InsightSelectionUpdate) => void;
}) {
  const { advance, back } = useWizard();
  const [cursor, setCursor] = useState(0);
  const [customFocused, setCustomFocused] = useState(false);
  const [error, setError] = useState<string>();

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

      const customArns = splitCommaList(customInsights);
      if (customArns.length === 0) {
        setError("At least one custom insight ARN is required");
        return;
      }
      const invalidArn = customArns.find((arn) => !arn.startsWith("arn:"));
      if (invalidArn !== undefined) {
        setError(`invalid insight "${invalidArn}": must be a full ARN`);
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
      setCursor((current) => Math.min(INSIGHT_CHOICES.length - 1, current + 1));
      return;
    }
    if (input === " ") {
      const selected = INSIGHT_CHOICES[cursor]!.value;
      if (selected === CUSTOM_INSIGHT) {
        onChange({ includeCustomInsight: !includeCustomInsight });
      } else {
        const toggled = builtinInsights.includes(selected)
          ? builtinInsights.filter((insight) => insight !== selected)
          : [...builtinInsights, selected];
        onChange({
          builtinInsights: BUILTIN_INSIGHT_CHOICES.filter((choice) =>
            toggled.includes(choice.value),
          ).map((choice) => choice.value),
        });
      }
      setError(undefined);
      return;
    }
    if (!key.return) return;

    if (builtinInsights.length === 0 && !includeCustomInsight) {
      setError("At least one insight is required");
      return;
    }
    if (includeCustomInsight) {
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
        helpText="select one or more insights with space"
        options={INSIGHT_CHOICES.map((choice) => ({
          label: choice.label,
          description: choice.description ?? "",
          checked:
            choice.value === CUSTOM_INSIGHT
              ? includeCustomInsight
              : builtinInsights.includes(choice.value),
        }))}
        cursorIndex={customFocused ? -1 : cursor}
      />
      {includeCustomInsight && (
        <FormTextInput
          name="Custom insight ARN"
          helpText="separate multiple ARNs with commas"
          placeholder="arn:aws:bedrock-agentcore:..."
          errorText=""
          value={customInsights}
          onChange={(value) => {
            onChange({ customInsights: value });
            setError(undefined);
          }}
          focused={customFocused}
        />
      )}
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

type InsightSettingsUpdate = Partial<
  Pick<OnlineInsightFormValues, "clusteringFrequencies" | "samplingRate" | "description">
>;

const SamplingRateSchema = z.number().min(0.01).max(100);
const DescriptionSchema = z.string().max(200);

function firstIssue(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  if (!issue) return "invalid value";
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

function samplingRateIssue(value: string): string | undefined {
  if (value.trim() === "") return "Sampling rate is required";
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return "Sampling rate must be a number";
  return firstIssue(SamplingRateSchema, Number(value));
}

function InsightSettingsField({
  clusteringFrequencies,
  samplingRate,
  description,
  onChange,
}: {
  clusteringFrequencies: ClusteringFrequency[];
  samplingRate: string;
  description: string;
  onChange: (update: InsightSettingsUpdate) => void;
}) {
  const { advance, back } = useWizard();
  const [focusedField, setFocusedField] = useState(0);
  const [clusteringCursor, setClusteringCursor] = useState(0);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "space", label: "toggle cadence" },
    { key: "enter", label: "continue" },
  ]);

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }

    if (focusedField === 0) {
      if (key.upArrow) {
        setClusteringCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setClusteringCursor((current) => Math.min(CLUSTERING_CHOICES.length - 1, current + 1));
        return;
      }
      if (input === " ") {
        const cadence = CLUSTERING_CHOICES[clusteringCursor]!.value;
        const toggled = clusteringFrequencies.includes(cadence)
          ? clusteringFrequencies.filter((frequency) => frequency !== cadence)
          : [...clusteringFrequencies, cadence];
        onChange({
          clusteringFrequencies: CLUSTERING_CHOICES.filter((choice) =>
            toggled.includes(choice.value),
          ).map((choice) => choice.value),
        });
        return;
      }
      if (key.return) {
        setFocusedField(1);
        setError(undefined);
      }
      return;
    }

    if (key.upArrow) {
      setFocusedField(focusedField - 1);
      setError(undefined);
      return;
    }
    if (key.downArrow && focusedField === 1) {
      setFocusedField(2);
      setError(undefined);
      return;
    }
    if (!key.return) return;

    const samplingIssue = samplingRateIssue(samplingRate);
    if (samplingIssue !== undefined) {
      setFocusedField(1);
      setError(samplingIssue);
      return;
    }
    if (focusedField === 1) {
      setFocusedField(2);
      setError(undefined);
      return;
    }

    const descriptionIssue =
      description === "" ? undefined : firstIssue(DescriptionSchema, description);
    if (descriptionIssue !== undefined) {
      setError(descriptionIssue);
      return;
    }

    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      <FormCheckboxMultiSelect
        name="Clustering cadence"
        helpText="optional · select one or more cadences with space"
        options={CLUSTERING_CHOICES.map((choice) => ({
          label: choice.label,
          description: choice.description ?? "",
          checked: clusteringFrequencies.includes(choice.value),
        }))}
        cursorIndex={focusedField === 0 ? clusteringCursor : -1}
      />
      <FormTextInput
        name="Sampling rate"
        helpText="required · percentage from 0.01 through 100"
        placeholder="10"
        errorText=""
        value={samplingRate}
        onChange={(value) => {
          onChange({ samplingRate: value });
          setError(undefined);
        }}
        focused={focusedField === 1}
      />
      <FormTextInput
        name="Description"
        helpText="optional · at most 200 characters"
        placeholder="Monitor production checkout sessions"
        errorText=""
        value={description}
        onChange={(value) => {
          onChange({ description: value });
          setError(undefined);
        }}
        focused={focusedField === 2}
      />
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}
