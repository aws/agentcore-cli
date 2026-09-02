import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import z from "zod";
import { ProjectKey } from "../../../../router";
import { GatewayAuthorizerConfigSchema } from "../../../../projectSchemas/auth";
import type { AgentCoreGateway } from "../../../../projectSchemas/gateway";
import type { ScreenProps } from "../../../types";
import type { AddResourceInput, Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  ChoiceField,
  TextAreaField,
  Summary,
} from "../../../../components/wizard";
import { gatewayResourceName } from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "gateway"];
const DESCRIPTION = "adds a Gateway to the current project";

// The service limit the handler enforces on the deployed Gateway name.
const MAX_RESOURCE_NAME_LENGTH = 48;

// The two protocols --protocol-type resolves to: "MCP" when passed, "None" when
// omitted. The wizard always states one, so `undefined` is not a choice here.
type ProtocolType = "MCP" | "None";
type AuthorizerType = "NONE" | "AWS_IAM" | "CUSTOM_JWT";

const PROTOCOL_CHOICES = [
  {
    value: "None" as ProtocolType,
    label: "None (default)",
    description: "any Target type",
  },
  {
    value: "MCP" as ProtocolType,
    label: "MCP",
    description: "restrict to MCP Targets · required for semantic tool search",
  },
];

const AUTHORIZER_CHOICES = [
  {
    value: "NONE" as AuthorizerType,
    label: "NONE (default)",
    description: "no inbound authorizer",
  },
  { value: "AWS_IAM" as AuthorizerType, label: "AWS_IAM", description: "SigV4-signed callers" },
  {
    value: "CUSTOM_JWT" as AuthorizerType,
    label: "CUSTOM_JWT",
    description: "your own JWT issuer · needs a configuration below",
  },
];

const SEMANTIC_SEARCH_CHOICES = [
  { value: false, label: "off (default)", description: "list tools exactly as the Targets expose" },
  { value: true, label: "on", description: "let callers search tools by meaning" },
];

interface GatewayFormValues {
  name: string;
  protocolType: ProtocolType;
  authorizerType: AuthorizerType;
  authorizerConfiguration: string;
  enableSemanticSearch: boolean;
  description: string;
}

// buildAddGatewayInput mirrors the flag-driven handler's construction, including
// the defaults it applies for the flags this wizard does not ask about.
export function buildAddGatewayInput(values: GatewayFormValues): AddResourceInput {
  const isCustomJwt = values.authorizerType === "CUSTOM_JWT";
  const gateway: AgentCoreGateway = {
    name: values.name.trim(),
    protocolType: values.protocolType,
    authorizerType: values.authorizerType,
    authorizerConfiguration: isCustomJwt
      ? GatewayAuthorizerConfigSchema.parse(JSON.parse(values.authorizerConfiguration))
      : undefined,
    description: values.description.trim() === "" ? undefined : values.description.trim(),
    targets: [],
    // Semantic search is an MCP-only setting; the handler rejects it otherwise,
    // so a protocol change away from MCP must not leave it on.
    enableSemanticSearch: values.protocolType === "MCP" ? values.enableSemanticSearch : false,
    exceptionLevel: "NONE",
  };
  return { resourceType: "gateway", resourceConfig: gateway };
}

function summaryOf(values: GatewayFormValues): Record<string, string> {
  return {
    gateway: values.name.trim(),
    protocol: values.protocolType,
    authorizer: values.authorizerType,
    ...(values.protocolType === "MCP"
      ? { "semantic search": values.enableSemanticSearch ? "on" : "off" }
      : {}),
    ...(values.description.trim() === "" ? {} : { description: values.description.trim() }),
  };
}

export function AddGatewayScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddGatewayWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddGatewayWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<GatewayFormValues>({
    name: "",
    protocolType: "None",
    authorizerType: "NONE",
    authorizerConfiguration: "",
    enableSemanticSearch: false,
    description: "",
  });
  const set = (update: Partial<GatewayFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  // The deployed name is derived from the project name, so the length limit can
  // only be checked here — and it is checked with the handler's own helper.
  const nameSchema = useMemo(
    () =>
      z.string().superRefine((name, ctx) => {
        const resourceName = gatewayResourceName(project.name, { name });
        if (resourceName.length > MAX_RESOURCE_NAME_LENGTH) {
          ctx.addIssue({
            code: "custom",
            message:
              `Gateway resource name '${resourceName}' exceeds the service limit of ` +
              `${MAX_RESOURCE_NAME_LENGTH} characters`,
          });
        }
      }),
    [project.name],
  );

  const isCustomJwt = values.authorizerType === "CUSTOM_JWT";
  const isMcp = values.protocolType === "MCP";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate("/agentcore/project/add")}
      onSubmit={() => core.projectManager.addResource(project, buildAddGatewayInput(values))}
      runningLabel={`adding Gateway ${values.name.trim()}…`}
      successLabel={`added Gateway '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this Gateway be called?">
        <TextField
          label="gateway name"
          help={`deployed as ${project.name}-<name>, up to ${MAX_RESOURCE_NAME_LENGTH} characters`}
          placeholder="tools"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
        />
      </Step>

      <Step name="protocol" question="which Target types should this Gateway accept?">
        <ChoiceField
          choices={PROTOCOL_CHOICES}
          value={values.protocolType}
          onChange={(protocolType) => set({ protocolType })}
        />
      </Step>

      <Step name="authorizer" question="how should inbound callers be authorized?">
        <ChoiceField
          choices={AUTHORIZER_CHOICES}
          value={values.authorizerType}
          onChange={(authorizerType) => set({ authorizerType })}
        />
      </Step>

      {isCustomJwt && (
        <Step
          name="authorizer-configuration"
          title="jwt config"
          question="paste the authorizerConfiguration for your JWT issuer"
        >
          <TextAreaField
            label="authorizer configuration"
            placeholder='{ "customJWTAuthorizer": { "discoveryUrl": "…" } }'
            value={values.authorizerConfiguration}
            onChange={(authorizerConfiguration) => set({ authorizerConfiguration })}
            required
            json
            schema={GatewayAuthorizerConfigSchema}
          />
        </Step>
      )}

      {isMcp && (
        <Step
          name="semantic-search"
          title="search"
          question="should tools be searchable by meaning?"
        >
          <ChoiceField
            choices={SEMANTIC_SEARCH_CHOICES}
            value={values.enableSemanticSearch}
            onChange={(enableSemanticSearch) => set({ enableSemanticSearch })}
          />
        </Step>
      )}

      <Step name="description" question="what is this Gateway for? (optional)">
        <TextField
          label="description"
          placeholder="internal tool gateway"
          value={values.description}
          onChange={(description) => set({ description })}
        />
      </Step>

      <Step name="review" question="this Gateway will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
