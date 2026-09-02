import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import z from "zod";
import { ProjectKey } from "../../../../router";
import type { PolicyEngineSchema } from "../../../../projectSchemas/policy";
import type { ScreenProps } from "../../../types";
import type { AddResourceInput, Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  ChoiceField,
  MultiChoiceField,
  Summary,
} from "../../../../components/wizard";
import { policyEngineResourceName } from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "policy-engine"];
const DESCRIPTION = "adds a Policy Engine to the current project";

// The service limit the handler enforces on the deployed engine name.
const MAX_RESOURCE_NAME_LENGTH = 48;

type AttachMode = "enforce" | "log-only";

const ATTACH_MODE_CHOICES = [
  {
    value: "enforce" as AttachMode,
    label: "enforce (default)",
    description: "deny requests the policies reject",
  },
  {
    value: "log-only" as AttachMode,
    label: "log-only",
    description: "record decisions without blocking anything",
  },
];

interface PolicyEngineFormValues {
  name: string;
  description: string;
  attachToGateways: string[];
  attachMode: AttachMode;
}

export function buildAddPolicyEngineInput(values: PolicyEngineFormValues): AddResourceInput {
  const engine: z.input<typeof PolicyEngineSchema> = {
    name: values.name.trim(),
    description: values.description.trim() === "" ? undefined : values.description.trim(),
  };
  return {
    resourceType: "policy-engine",
    resourceConfig: engine,
    // The handler treats an absent --attach-to-gateways as "attach to nothing",
    // and --attach-mode is meaningless without it.
    attachGateways:
      values.attachToGateways.length === 0
        ? undefined
        : {
            names: values.attachToGateways,
            mode: values.attachMode === "log-only" ? "LOG_ONLY" : "ENFORCE",
          },
  };
}

function summaryOf(values: PolicyEngineFormValues): Record<string, string> {
  return {
    "policy engine": values.name.trim(),
    ...(values.description.trim() === "" ? {} : { description: values.description.trim() }),
    "attached gateways":
      values.attachToGateways.length === 0 ? "none" : values.attachToGateways.join(", "),
    ...(values.attachToGateways.length === 0 ? {} : { mode: values.attachMode }),
  };
}

export function AddPolicyEngineScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddPolicyEngineWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddPolicyEngineWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<PolicyEngineFormValues>({
    name: "",
    description: "",
    attachToGateways: [],
    attachMode: "enforce",
  });
  const set = (update: Partial<PolicyEngineFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const nameSchema = useMemo(
    () =>
      z.string().superRefine((name, ctx) => {
        const resourceName = policyEngineResourceName(project.name, name);
        if (resourceName.length > MAX_RESOURCE_NAME_LENGTH) {
          ctx.addIssue({
            code: "custom",
            message:
              `Policy Engine resource name '${resourceName}' exceeds the service limit of ` +
              `${MAX_RESOURCE_NAME_LENGTH} characters`,
          });
        }
      }),
    [project.name],
  );

  // Attachment targets are the Gateways this project already declares, so the
  // step is offered only when there is something to attach to.
  const gatewayChoices = useMemo(
    () =>
      (project.spec.agentCoreGateways ?? []).map((gateway) => ({
        value: gateway.name,
        label: gateway.name,
        description: gateway.description ?? gateway.protocolType,
      })),
    [project.spec.agentCoreGateways],
  );

  const hasGateways = gatewayChoices.length > 0;
  const isAttaching = values.attachToGateways.length > 0;

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate("/agentcore/project/add")}
      onSubmit={() => core.projectManager.addResource(project, buildAddPolicyEngineInput(values))}
      runningLabel={`adding Policy Engine ${values.name.trim()}…`}
      successLabel={`added Policy Engine '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this Policy Engine be called?">
        <TextField
          label="policy engine name"
          help={`deployed as ${project.name}_<name>, up to ${MAX_RESOURCE_NAME_LENGTH} characters`}
          placeholder="access"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
        />
      </Step>

      <Step name="description" question="what does this engine govern? (optional)">
        <TextField
          label="description"
          placeholder="tool access rules"
          value={values.description}
          onChange={(description) => set({ description })}
        />
      </Step>

      {hasGateways && (
        <Step name="attach" title="attach" question="which Gateways should this engine govern?">
          <MultiChoiceField
            label="project gateways"
            help="leave empty to attach nothing for now"
            choices={gatewayChoices}
            value={values.attachToGateways}
            onChange={(attachToGateways) => set({ attachToGateways })}
          />
        </Step>
      )}

      {hasGateways && isAttaching && (
        <Step name="mode" question="how should the attached Gateways enforce this engine?">
          <ChoiceField
            choices={ATTACH_MODE_CHOICES}
            value={values.attachMode}
            onChange={(attachMode) => set({ attachMode })}
          />
        </Step>
      )}

      <Step name="review" question="this Policy Engine will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
