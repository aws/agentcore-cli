import { useState } from "react";
import { useNavigate } from "react-router";
import z from "zod";
import { ProjectKey } from "../../../../router";
import { OnlineEvalConfigNameSchema } from "../../../../projectSchemas/online-eval-config";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  MultiChoiceField,
  Summary,
  splitList,
} from "../../../../components/wizard";
import {
  emptyMonitoringValues,
  monitoringSummary,
  toMonitoringInput,
  useMonitoringSteps,
  type MonitoringFormValues,
} from "../monitoring-steps";
import {
  BUILTIN_INSIGHT_PREFIX,
  InsightIdSchema,
  toAddOnlineInsightInput,
  type ClusteringFrequency,
  type OnlineInsightInput,
} from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "online-insight"];
const DESCRIPTION = "adds an online insight config to the current project";
const ADD_MENU = "/agentcore/project/add";

const FREQUENCY_CHOICES = [
  { value: "DAILY" as ClusteringFrequency, label: "DAILY", description: "cluster every day" },
  { value: "WEEKLY" as ClusteringFrequency, label: "WEEKLY", description: "cluster every week" },
  { value: "MONTHLY" as ClusteringFrequency, label: "MONTHLY", description: "cluster every month" },
];

// The insights step collects a comma-separated list, each entry checked with
// the handler's own InsightIdSchema so the wizard refuses what the flag refuses.
const InsightsInputSchema = z
  .string()
  .transform((raw) => splitList(raw) ?? [])
  .pipe(z.array(InsightIdSchema).min(1, "enter at least one insight"));

interface OnlineInsightFormValues extends MonitoringFormValues {
  insights: string;
  clusteringFrequencies: ClusteringFrequency[];
}

export function toOnlineInsightInput(values: OnlineInsightFormValues): OnlineInsightInput {
  return {
    ...toMonitoringInput(values),
    insights: splitList(values.insights),
    clusteringFrequencies:
      values.clusteringFrequencies.length === 0 ? undefined : values.clusteringFrequencies,
  };
}

function summaryOf(values: OnlineInsightFormValues): Record<string, string> {
  const input = toOnlineInsightInput(values);
  return {
    "online insight": values.name.trim(),
    ...monitoringSummary(values),
    insights: input.insights?.join(", ") ?? "",
    ...(input.clusteringFrequencies === undefined
      ? {}
      : { clustering: input.clusteringFrequencies.join(", ") }),
  };
}

export function AddOnlineInsightScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddOnlineInsightWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddOnlineInsightWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const [values, setValues] = useState<OnlineInsightFormValues>(() => ({
    ...emptyMonitoringValues(project),
    insights: "",
    clusteringFrequencies: [],
  }));
  const set = (update: Partial<OnlineInsightFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const { sourceSteps, trailingSteps } = useMonitoringSteps(project, values, set, "insight");

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(
          project,
          toAddOnlineInsightInput(toOnlineInsightInput(values)),
        )
      }
      runningLabel={`adding online-insight config ${values.name.trim()}…`}
      successLabel={`added online-insight config '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this online insight config be called?">
        <TextField
          label="config name"
          placeholder="prod_failures"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={OnlineEvalConfigNameSchema}
        />
      </Step>

      {sourceSteps}

      <Step name="insights" question="which insights should be generated?">
        <TextField
          label="insights"
          help={`${BUILTIN_INSIGHT_PREFIX}* IDs or insight ARNs, comma-separated`}
          placeholder={`${BUILTIN_INSIGHT_PREFIX}FailureAnalysis`}
          value={values.insights}
          onChange={(insights) => set({ insights })}
          required
          schema={InsightsInputSchema}
        />
      </Step>

      <Step name="clustering" question="how often should sessions be clustered? (optional)">
        <MultiChoiceField
          label="clustering frequency"
          help="leave empty to accept the service default"
          choices={FREQUENCY_CHOICES}
          value={values.clusteringFrequencies}
          onChange={(clusteringFrequencies) => set({ clusteringFrequencies })}
        />
      </Step>

      {trailingSteps}

      <Step name="review" question="this config will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
