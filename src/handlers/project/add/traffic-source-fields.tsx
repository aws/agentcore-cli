import type { ReactElement } from "react";
import z from "zod";
import {
  ChoiceField,
  Step,
  TextField,
  type Choice,
  type StepProps,
} from "../../../components/wizard";
import type { Project } from "../types";

export type TrafficSourceType = "runtime" | "logs";

export interface TrafficSourceFormValues {
  sourceType: TrafficSourceType;
  runtime: string;
  endpoint: string | undefined;
  logGroups: string;
  serviceNames: string;
}

export const TrafficSourceLogGroupsSchema = z.string().superRefine((value, ctx) => {
  const logGroups = splitCommaList(value);
  if (logGroups.length === 0) {
    ctx.addIssue({ code: "custom", message: "At least one log group is required" });
  } else if (logGroups.length > 5) {
    ctx.addIssue({ code: "custom", message: "At most five log groups may be supplied" });
  }
});

export const TrafficSourceServiceNamesSchema = z.string().superRefine((value, ctx) => {
  if (splitCommaList(value).length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Enter at least one service name or leave this blank",
    });
  }
});

const SOURCE_CHOICES: Choice<TrafficSourceType>[] = [
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

export function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function initialTrafficSourceValues(runtime: string): TrafficSourceFormValues {
  return {
    sourceType: runtime === "" ? "logs" : "runtime",
    runtime,
    endpoint: undefined,
    logGroups: "",
    serviceNames: "",
  };
}

export function toTrafficSourceInput(values: TrafficSourceFormValues) {
  return {
    agent: values.sourceType === "runtime" ? values.runtime : undefined,
    endpoint: values.sourceType === "runtime" ? values.endpoint : undefined,
    logGroupNames: values.sourceType === "logs" ? splitCommaList(values.logGroups) : undefined,
    serviceNames:
      values.sourceType === "logs" && values.serviceNames.trim() !== ""
        ? splitCommaList(values.serviceNames)
        : undefined,
  };
}

export function trafficSourceSummary(values: TrafficSourceFormValues): Record<string, string> {
  const serviceNames = splitCommaList(values.serviceNames);
  return {
    source:
      values.sourceType === "runtime"
        ? `${values.runtime}:${values.endpoint ?? "DEFAULT"}`
        : splitCommaList(values.logGroups).join(", "),
    ...(values.sourceType === "logs" && serviceNames.length > 0
      ? { services: serviceNames.join(", ") }
      : {}),
  };
}

interface TrafficSourceStepsProps {
  values: TrafficSourceFormValues;
  runtimes: Project["spec"]["runtimes"];
  onChange: (update: Partial<TrafficSourceFormValues>) => void;
}

// Wizard discovers direct Step elements before rendering them. Returning an
// array keeps these shared steps direct children while avoiding duplicated
// Runtime and custom-log flows in online evaluation wizards.
export function trafficSourceSteps({
  values,
  runtimes,
  onChange,
}: TrafficSourceStepsProps): ReactElement<StepProps>[] {
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
  const endpointChoices: Choice<string | undefined>[] = [
    {
      value: undefined,
      label: "NO ENDPOINT (default)",
      description: "sample traffic sent to the Runtime's default endpoint",
    },
    ...namedEndpoints.map((endpoint) => ({ value: endpoint, label: endpoint })),
  ];

  return [
    <Step key="source" stepKey="source" prompt="where should sessions be sampled from?">
      <ChoiceField
        choices={sourceChoices}
        value={values.sourceType}
        onChange={(sourceType) => onChange({ sourceType })}
      />
    </Step>,
    ...(values.sourceType === "runtime"
      ? [
          <Step key="runtime" stepKey="runtime" prompt="which Runtime should be monitored?">
            <ChoiceField
              choices={runtimeChoices}
              value={values.runtime}
              onChange={(runtime) => onChange({ runtime, endpoint: undefined })}
            />
          </Step>,
        ]
      : []),
    ...(values.sourceType === "runtime" && namedEndpoints.length > 0
      ? [
          <Step
            key="endpoint"
            stepKey="endpoint"
            prompt="which Runtime endpoint should be monitored?"
          >
            <ChoiceField
              choices={endpointChoices}
              value={values.endpoint}
              onChange={(endpoint) => onChange({ endpoint })}
            />
          </Step>,
        ]
      : []),
    ...(values.sourceType === "logs"
      ? [
          <Step
            key="log-groups"
            stepKey="log-groups"
            prompt="which CloudWatch log groups contain the sessions?"
          >
            <TextField
              label="Log groups"
              help="one to five names, separated by commas"
              placeholder="/aws/bedrock-agentcore/runtimes/example"
              value={values.logGroups}
              onChange={(logGroups) => onChange({ logGroups })}
              required
              schema={TrafficSourceLogGroupsSchema}
            />
          </Step>,
          <Step
            key="services"
            stepKey="services"
            prompt="limit traces to particular service names?"
          >
            <TextField
              label="Service names"
              help="optional · separate multiple names with commas"
              placeholder="checkout, inventory"
              value={values.serviceNames}
              onChange={(serviceNames) => onChange({ serviceNames })}
              schema={TrafficSourceServiceNamesSchema}
            />
          </Step>,
        ]
      : []),
  ];
}
