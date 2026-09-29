import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import z from "zod";
import {
  ChoiceField,
  MultiChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import { InputValidationError } from "../../../../errors";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import { OnlineEvalConfigNameSchema } from "../../../../projectSchemas/online-eval-config";
import { TagsSchema } from "../../../../projectSchemas/tags";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import { parseTags } from "../../../utils";
import { LoadingFrame, ProjectGate, projectQueryKey, useProjectTargets } from "../../ProjectGate";
import type { Project } from "../../types";
import { requireDeployedNameFits } from "../shared";
import {
  ONLINE_INSIGHT_DEPLOYED_NAME_MAX_LENGTH,
  toAddOnlineInsightInput,
  validateInsightIds,
  type OnlineInsightInput,
} from "./index";

const BREADCRUMB = ["agentcore", "add", "online-insight"];
const DESCRIPTION = "add an online insight config to the current project";
const ADD_MENU = "/agentcore/add";
const DEFAULT_ENDPOINT = "DEFAULT";

type SourceType = "runtime" | "logs";
type ClusteringFrequency = "DAILY" | "WEEKLY" | "MONTHLY";

const SOURCE_CHOICES: Choice<SourceType>[] = [
  {
    value: "runtime",
    label: "project Runtime",
    description: "sample traffic from a Runtime declared in agentcore.json",
  },
  {
    value: "logs",
    label: "CloudWatch logs",
    description: "read one or more custom CloudWatch log groups",
  },
];

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

const CLUSTERING_CHOICES: Choice<ClusteringFrequency>[] = [
  { value: "DAILY", label: "DAILY" },
  { value: "WEEKLY", label: "WEEKLY" },
  { value: "MONTHLY", label: "MONTHLY" },
];

const ENABLE_CHOICES: Choice<boolean>[] = [
  {
    value: true,
    label: "enabled (default)",
    description: "start producing insights as soon as the project is deployed",
  },
  {
    value: false,
    label: "paused",
    description: "deploy the config without enabling it",
  },
];

interface OnlineInsightFormValues {
  name: string;
  sourceType: SourceType;
  runtime: string;
  endpoint: string;
  logGroups: string;
  serviceNames: string;
  builtinInsights: string[];
  customInsights: string;
  clusteringFrequencies: ClusteringFrequency[];
  samplingRate: string;
  description: string;
  enableOnCreate: boolean;
  tags: string;
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function parseTagsText(value: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  const parsed = parseTags(trimmed.startsWith("{") ? [trimmed] : splitCommaList(trimmed));
  const result = TagsSchema.safeParse(parsed);
  if (!result.success) throw new InputValidationError(z.prettifyError(result.error));
  return result.data;
}

function firstError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LogGroupsSchema = z.string().superRefine((value, ctx) => {
  const logGroups = splitCommaList(value);
  if (logGroups.length === 0) {
    ctx.addIssue({ code: "custom", message: "At least one log group is required" });
  } else if (logGroups.length > 5) {
    ctx.addIssue({ code: "custom", message: "At most five log groups may be supplied" });
  }
});

const ServiceNamesSchema = z.string().superRefine((value, ctx) => {
  if (splitCommaList(value).length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Enter at least one service name or leave this blank",
    });
  }
});

const TagsInputSchema = z.string().superRefine((value, ctx) => {
  try {
    parseTagsText(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: firstError(error) });
  }
});

function customInsightsSchema(hasBuiltinInsights: boolean) {
  return z.string().superRefine((value, ctx) => {
    const customInsights = splitCommaList(value);
    if (!hasBuiltinInsights && customInsights.length === 0) {
      ctx.addIssue({ code: "custom", message: "At least one insight is required" });
      return;
    }
    try {
      validateInsightIds(customInsights);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: firstError(error) });
    }
  });
}

export function toOnlineInsightInput(values: OnlineInsightFormValues): OnlineInsightInput {
  return {
    name: values.name,
    agent: values.sourceType === "runtime" ? values.runtime : undefined,
    endpoint:
      values.sourceType === "runtime" && values.endpoint !== DEFAULT_ENDPOINT
        ? values.endpoint
        : undefined,
    logGroupNames: values.sourceType === "logs" ? splitCommaList(values.logGroups) : undefined,
    serviceNames:
      values.sourceType === "logs" && values.serviceNames.trim() !== ""
        ? splitCommaList(values.serviceNames)
        : undefined,
    insights: [...values.builtinInsights, ...splitCommaList(values.customInsights)],
    clusteringFrequencies:
      values.clusteringFrequencies.length === 0 ? undefined : values.clusteringFrequencies,
    samplingRate: Number(values.samplingRate),
    description: values.description === "" ? undefined : values.description,
    enableOnCreate: values.enableOnCreate ? undefined : false,
    tags: parseTagsText(values.tags),
  };
}

function summaryOf(values: OnlineInsightFormValues): Record<string, string> {
  const insights = [...values.builtinInsights, ...splitCommaList(values.customInsights)];
  const logGroups = splitCommaList(values.logGroups);
  const serviceNames = splitCommaList(values.serviceNames);
  return {
    config: values.name,
    source:
      values.sourceType === "runtime"
        ? `${values.runtime}:${values.endpoint}`
        : logGroups.join(", "),
    ...(values.sourceType === "logs" && serviceNames.length > 0
      ? { services: serviceNames.join(", ") }
      : {}),
    insights: insights.join(", "),
    clustering:
      values.clusteringFrequencies.length === 0
        ? "(none)"
        : values.clusteringFrequencies.join(", "),
    sampling: `${values.samplingRate}%`,
    description: values.description === "" ? "(none)" : values.description,
    enabled: values.enableOnCreate ? "yes" : "no",
    tags: values.tags.trim() === "" ? "(none)" : values.tags,
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
      {(project) => <AddOnlineInsightLoader project={project} core={core} />}
    </ProjectGate>
  );
}

function AddOnlineInsightLoader({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const targets = useProjectTargets(core, project);

  if (targets.data !== undefined) {
    return <AddOnlineInsightWizard project={project} targets={targets.data} core={core} />;
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
}: {
  project: Project;
  targets: readonly AwsDeploymentTarget[];
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runtimes = project.spec.runtimes;
  const initialRuntime = runtimes[0]?.name ?? "";
  const [values, setValues] = useState<OnlineInsightFormValues>({
    name: "",
    sourceType: runtimes.length === 0 ? "logs" : "runtime",
    runtime: initialRuntime,
    endpoint: DEFAULT_ENDPOINT,
    logGroups: "",
    serviceNames: "",
    builtinInsights: [],
    customInsights: "",
    clusteringFrequencies: [],
    samplingRate: "",
    description: "",
    enableOnCreate: true,
    tags: "",
  });
  const set = (update: Partial<OnlineInsightFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const sourceChoices =
    runtimes.length === 0
      ? SOURCE_CHOICES.filter((choice) => choice.value === "logs")
      : SOURCE_CHOICES;
  const runtimeChoices: Choice<string>[] = runtimes.map((runtime) => ({
    value: runtime.name,
    label: runtime.name,
    description: runtime.description ?? runtime.codeLocation,
  }));
  const selectedRuntime = runtimes.find((runtime) => runtime.name === values.runtime);
  const namedEndpoints = Object.keys(selectedRuntime?.endpoints ?? {});
  const endpointChoices: Choice<string>[] = [
    {
      value: DEFAULT_ENDPOINT,
      label: `${DEFAULT_ENDPOINT} (default)`,
      description: "sample traffic sent to the Runtime's default endpoint",
    },
    ...namedEndpoints.map((endpoint) => ({ value: endpoint, label: endpoint })),
  ];

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
          ctx.addIssue({ code: "custom", message: firstError(error) });
        }
      }),
    [project.name, targets],
  );
  const insightSchema = useMemo(
    () => customInsightsSchema(values.builtinInsights.length > 0),
    [values.builtinInsights.length],
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

      <Step stepKey="source" prompt="where should sessions be sampled from?">
        <ChoiceField
          choices={sourceChoices}
          value={values.sourceType}
          onChange={(sourceType) => set({ sourceType })}
        />
      </Step>

      {values.sourceType === "runtime" && (
        <Step stepKey="runtime" prompt="which Runtime should be monitored?">
          <ChoiceField
            choices={runtimeChoices}
            value={values.runtime}
            onChange={(runtime) => set({ runtime, endpoint: DEFAULT_ENDPOINT })}
          />
        </Step>
      )}

      {values.sourceType === "runtime" && namedEndpoints.length > 0 && (
        <Step stepKey="endpoint" prompt="which Runtime endpoint should be monitored?">
          <ChoiceField
            choices={endpointChoices}
            value={values.endpoint}
            onChange={(endpoint) => set({ endpoint })}
          />
        </Step>
      )}

      {values.sourceType === "logs" && (
        <Step stepKey="log-groups" prompt="which CloudWatch log groups contain the sessions?">
          <TextField
            label="Log groups"
            help="one to five names, separated by commas"
            placeholder="/aws/bedrock-agentcore/runtimes/example"
            value={values.logGroups}
            onChange={(logGroups) => set({ logGroups })}
            required
            schema={LogGroupsSchema}
          />
        </Step>
      )}

      {values.sourceType === "logs" && (
        <Step stepKey="services" prompt="limit traces to particular service names?">
          <TextField
            label="Service names"
            help="optional · separate multiple names with commas"
            placeholder="checkout, inventory"
            value={values.serviceNames}
            onChange={(serviceNames) => set({ serviceNames })}
            schema={ServiceNamesSchema}
          />
        </Step>
      )}

      <Step stepKey="builtins" prompt="which built-in insights should be produced?">
        <MultiChoiceField
          help="select none if you will provide an insight ARN next · space toggles"
          choices={BUILTIN_INSIGHT_CHOICES}
          value={values.builtinInsights}
          onChange={(builtinInsights) => set({ builtinInsights })}
        />
      </Step>

      <Step stepKey="custom-insights" prompt="add any other insight identifiers?">
        <TextField
          label="Insight identifiers"
          help="optional when a built-in is selected · comma-separated Builtin.Insight.* IDs or ARNs"
          placeholder="arn:aws:bedrock-agentcore:..."
          value={values.customInsights}
          onChange={(customInsights) => set({ customInsights })}
          required={values.builtinInsights.length === 0}
          schema={insightSchema}
        />
      </Step>

      <Step stepKey="clustering" prompt="how often should insight clusters be generated?">
        <MultiChoiceField
          help="optional · select one or more cadences with space"
          choices={CLUSTERING_CHOICES}
          value={values.clusteringFrequencies}
          onChange={(clusteringFrequencies) => set({ clusteringFrequencies })}
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

      <Step stepKey="description" prompt="describe this config's monitoring purpose">
        <TextField
          label="Description"
          help="optional · at most 200 characters"
          placeholder="Monitor production checkout sessions"
          value={values.description}
          onChange={(description) => set({ description })}
          schema={z.string().max(200)}
        />
      </Step>

      <Step stepKey="enabled" prompt="enable this config when it is deployed?">
        <ChoiceField
          choices={ENABLE_CHOICES}
          value={values.enableOnCreate}
          onChange={(enableOnCreate) => set({ enableOnCreate })}
        />
      </Step>

      <Step stepKey="tags" prompt="add tags to this online insight config?">
        <TextField
          label="Tags"
          help="optional · comma-separated key=value pairs, or a JSON object"
          placeholder="team=checkout, environment=production"
          value={values.tags}
          onChange={(tags) => set({ tags })}
          schema={TagsInputSchema}
        />
      </Step>

      <Step stepKey="review" prompt="this online insight config will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
