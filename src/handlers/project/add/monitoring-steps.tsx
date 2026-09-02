import { useMemo } from "react";
import z from "zod";
import { LogGroupNamesSchema } from "../../../projectSchemas/online-eval-config";
import type { Project } from "../types";
import {
  Step,
  TextField,
  ChoiceField,
  blankToUndefined,
  splitList,
  numberSchema,
} from "../../../components/wizard";

// The online-eval and online-insight configs monitor the same two kinds of
// source — a project agent's traffic, or CloudWatch log groups — and share the
// name, sampling-rate and enable-on-create questions. Both wizards use these
// steps, so the two say the same things and produce the same shapes.

export type MonitoringSourceKind = "agent" | "log-groups";

export interface MonitoringFormValues {
  name: string;
  source: MonitoringSourceKind;
  agent: string;
  endpoint: string;
  logGroupNames: string;
  serviceNames: string;
  samplingRate: string;
  enableOnCreate: boolean;
  description: string;
}

// The fields OnlineEvalConfigSchema takes that describe the source and the
// sampling, as the wizards' input builders expect them.
export interface MonitoringInput {
  name: string;
  agent?: string;
  endpoint?: string;
  logGroupNames?: string[];
  serviceNames?: string[];
  samplingRate: number;
  enableOnCreate?: boolean;
  description?: string;
}

export function emptyMonitoringValues(project: Project): MonitoringFormValues {
  const firstAgent = project.spec.runtimes[0]?.name;
  return {
    name: "",
    source: firstAgent === undefined ? "log-groups" : "agent",
    agent: firstAgent ?? "",
    endpoint: "",
    logGroupNames: "",
    serviceNames: "",
    samplingRate: "",
    enableOnCreate: true,
    description: "",
  };
}

// toMonitoringInput passes only the answers of the source branch the user saw,
// so a log group typed before switching to an agent is dropped rather than
// tripping the schema's "mutually exclusive" rule.
export function toMonitoringInput(values: MonitoringFormValues): MonitoringInput {
  const fromAgent = values.source === "agent";
  return {
    name: values.name.trim(),
    agent: fromAgent ? values.agent : undefined,
    endpoint: fromAgent ? blankToUndefined(values.endpoint) : undefined,
    logGroupNames: fromAgent ? undefined : splitList(values.logGroupNames),
    serviceNames: fromAgent ? undefined : splitList(values.serviceNames),
    samplingRate: Number(values.samplingRate),
    enableOnCreate: values.enableOnCreate,
    description: blankToUndefined(values.description),
  };
}

export function monitoringSummary(values: MonitoringFormValues): Record<string, string> {
  const input = toMonitoringInput(values);
  return {
    ...(input.agent === undefined
      ? { "log groups": input.logGroupNames?.join(", ") ?? "" }
      : { agent: input.agent + (input.endpoint === undefined ? "" : ` (${input.endpoint})`) }),
    ...(input.serviceNames === undefined ? {} : { services: input.serviceNames.join(", ") }),
    "sampling rate": `${input.samplingRate}%`,
    "on deploy": input.enableOnCreate ? "enabled" : "paused",
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}

const SOURCE_CHOICES = [
  {
    value: "agent" as MonitoringSourceKind,
    label: "a project agent",
    description: "sample the traffic of a runtime declared in this project",
  },
  {
    value: "log-groups" as MonitoringSourceKind,
    label: "CloudWatch log groups",
    description: "sample traces from up to five log groups you name",
  },
];

const ENABLE_CHOICES = [
  { value: true, label: "enabled (default)", description: "start sampling as soon as it deploys" },
  { value: false, label: "paused", description: "deploy it, but leave it off until resumed" },
];

// The schema's own bounds for --sampling-rate, reached through a text field.
const SamplingRateInputSchema = numberSchema(
  z.number().min(0.01).max(100),
  "enter a percentage between 0.01 and 100",
);

// LogGroupsInputSchema reads a comma-separated answer as the 1-5 log groups the
// schema allows, so the step reports the same limit the flag path reports.
const LogGroupsInputSchema = z
  .string()
  .transform((raw) => splitList(raw) ?? [])
  .pipe(LogGroupNamesSchema);

export function useMonitoringSteps(
  project: Project,
  values: MonitoringFormValues,
  set: (update: Partial<MonitoringFormValues>) => void,
  // noun is what the config is called in questions: "evaluation" or "insight".
  noun: string,
) {
  const agentChoices = useMemo(
    () =>
      project.spec.runtimes.map((runtime) => ({
        value: runtime.name,
        label: runtime.name,
        description: runtime.description ?? "",
      })),
    [project.spec.runtimes],
  );
  const hasAgents = agentChoices.length > 0;
  const fromAgent = hasAgents && values.source === "agent";

  // sourceSteps go after the name; trailingSteps go after the config-specific
  // questions. Arrays, because React.Children.toArray flattens them into the
  // Wizard's step list.
  const sourceSteps = [
    hasAgents && (
      <Step key="source" name="source" question={`what should this ${noun} config monitor?`}>
        <ChoiceField
          choices={SOURCE_CHOICES}
          value={values.source}
          onChange={(source) => set({ source })}
        />
      </Step>
    ),

    fromAgent && (
      <Step key="agent" name="agent" question="which agent's traffic should be sampled?">
        <ChoiceField
          choices={agentChoices}
          value={values.agent}
          onChange={(agent) => set({ agent })}
        />
      </Step>
    ),

    fromAgent && (
      <Step key="endpoint" name="endpoint" question="scope to one endpoint? (optional)">
        <TextField
          label="endpoint"
          help="an endpoint qualifier such as DEFAULT; blank monitors every endpoint"
          placeholder="DEFAULT"
          value={values.endpoint}
          onChange={(endpoint) => set({ endpoint })}
        />
      </Step>
    ),

    !fromAgent && (
      <Step
        key="log-groups"
        name="log-groups"
        title="log groups"
        question="which CloudWatch log groups?"
      >
        <TextField
          label="log groups"
          help="one to five, comma-separated"
          placeholder="/aws/bedrock-agentcore/runtimes/my-agent"
          value={values.logGroupNames}
          onChange={(logGroupNames) => set({ logGroupNames })}
          required
          schema={LogGroupsInputSchema}
        />
      </Step>
    ),

    !fromAgent && (
      <Step
        key="services"
        name="services"
        question="filter traces to particular services? (optional)"
      >
        <TextField
          label="service names"
          help="comma-separated; blank keeps every service in the log groups"
          placeholder="checkout-agent"
          value={values.serviceNames}
          onChange={(serviceNames) => set({ serviceNames })}
        />
      </Step>
    ),
  ];

  const trailingSteps = [
    <Step key="sampling" name="sampling" question="what share of sessions should be sampled?">
      <TextField
        label="sampling rate"
        help="a percentage, 0.01-100"
        placeholder="10"
        value={values.samplingRate}
        onChange={(samplingRate) => set({ samplingRate })}
        required
        schema={SamplingRateInputSchema}
      />
    </Step>,

    <Step key="enabled" name="enabled" question={`should ${noun} start when this deploys?`}>
      <ChoiceField
        choices={ENABLE_CHOICES}
        value={values.enableOnCreate}
        onChange={(enableOnCreate) => set({ enableOnCreate })}
      />
    </Step>,

    <Step key="description" name="description" question="what is this config for? (optional)">
      <TextField
        label="description"
        help="up to 200 characters"
        placeholder="production quality monitoring"
        value={values.description}
        onChange={(description) => set({ description })}
        schema={z.string().max(200)}
      />
    </Step>,
  ];

  return { sourceSteps, trailingSteps };
}
