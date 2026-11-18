import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  ChoiceField,
  ResourceChoiceField,
  ResourceEmptyState,
  RevealChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import {
  TARGET_TYPE_AUTH_CONFIG,
  type AgentCoreGateway,
  type GatewayTargetType,
} from "../../../../projectSchemas/gateway";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import {
  HttpsEndpointSchema,
  toAddGatewayTargetInput,
  type GatewayTargetShortcutInput,
} from "./index";
import { RegionKey } from "../../../keys";

const BREADCRUMB = ["agentcore", "add", "gateway-target"];
const DESCRIPTION = "add a Target to a project Gateway";
const ADD_MENU = "/agentcore/add";

// The two shortcuts the flags offer: --endpoint and --runtime. The eight-way
// --target-configuration JSON stays on the command line.
type TargetKind = "endpoint" | "runtime";

const TARGET_TYPE_OF: Record<TargetKind, GatewayTargetType> = {
  endpoint: "mcpServer",
  runtime: "httpRuntime",
};

const ENDPOINT_KIND: Choice<TargetKind> = {
  value: "endpoint",
  label: "an MCP server I host elsewhere",
  description: "an HTTPS endpoint the Gateway calls",
};

const RUNTIME_KIND: Choice<TargetKind> = {
  value: "runtime",
  label: "a Runtime in this project",
  description: "a Runtime declared in agentcore.json",
};

// AuthChoice is the outbound auth as the flags state it: "none" is an explicit
// --outbound-auth none, "oauth" names a credential, and "iam" is no flag at all,
// which for a Runtime Target means the Gateway calls it with its own role.
type AuthChoice = "none" | "iam" | "oauth";

const NONE_AUTH: Choice<AuthChoice> = {
  value: "none",
  label: "none (default)",
  description: "call the MCP server without credentials",
};

const IAM_AUTH: Choice<AuthChoice> = {
  value: "iam",
  label: "Gateway IAM role (default)",
  description: "SigV4-signed calls with the Gateway's own execution role",
};

const OAUTH_AUTH: Choice<AuthChoice> = {
  value: "oauth",
  label: "OAuth",
  description: "a token from an OAuth credential in this project",
};

// authChoices offers only what the project schema accepts for the Target type,
// read off the same table the schema validates with. Neither shortcut type
// takes API_KEY, so the wizard never offers it. A type that falls back to the
// Gateway's IAM role is offered that instead of NONE: Runtimes only accept
// AWS_IAM or CUSTOM_JWT callers, so an unauthenticated call could never land.
export function authChoices(kind: TargetKind): Choice<AuthChoice>[] {
  const config = TARGET_TYPE_AUTH_CONFIG[TARGET_TYPE_OF[kind]];
  const choices: Choice<AuthChoice>[] = [];
  if (config.iamRoleFallback) choices.push(IAM_AUTH);
  else if (config.validAuthTypes.includes("NONE")) choices.push(NONE_AUTH);
  if (config.validAuthTypes.includes("OAUTH")) choices.push(OAUTH_AUTH);
  return choices;
}

// A Runtime Target is only legal on a Gateway with protocolType None; the
// schema rejects it on an MCP Gateway.
function acceptsRuntimeTargets(gateway: AgentCoreGateway | undefined): boolean {
  return gateway?.protocolType === "None";
}

function kindChoices(gateway: AgentCoreGateway | undefined): Choice<TargetKind>[] {
  return acceptsRuntimeTargets(gateway) ? [ENDPOINT_KIND, RUNTIME_KIND] : [ENDPOINT_KIND];
}

function gatewayChoices(gateways: readonly AgentCoreGateway[]): Choice<string>[] {
  return gateways.map((gateway) => ({
    value: gateway.name,
    label: gateway.name,
    description: `${gateway.targets.length} ${gateway.targets.length === 1 ? "Target" : "Targets"} · ${
      acceptsRuntimeTargets(gateway) ? "MCP servers and Runtimes" : "MCP servers only"
    }`,
  }));
}

function runtimeChoices(runtimes: readonly ProjectRuntime[]): Choice<string>[] {
  return runtimes.map((runtime) => ({
    value: runtime.name,
    label: runtime.name,
    description: runtime.codeLocation,
  }));
}

// The Runtime's named endpoints, behind the implicit DEFAULT one. undefined is
// the answer --runtime-endpoint omitted gives.
function runtimeEndpointChoices(runtime: ProjectRuntime | undefined): Choice<string | undefined>[] {
  return [
    {
      value: undefined,
      label: "DEFAULT (default)",
      description: "the Runtime's default endpoint, following its latest version",
    },
    ...Object.entries(runtime?.endpoints ?? {}).map(([name, endpoint]) => ({
      value: name,
      label: name,
      description: `version ${endpoint.version}${endpoint.description ? ` · ${endpoint.description}` : ""}`,
    })),
  ];
}

type GatewayTargetFormValues = {
  gateway: string;
  kind: TargetKind;
  endpoint: string;
  runtime: string;
  // undefined is the Runtime's DEFAULT endpoint, as when --runtime-endpoint is
  // omitted.
  runtimeEndpoint: string | undefined;
  name: string;
  auth: AuthChoice;
  credential: string;
  scopes: string;
};

// toGatewayTargetInput is the answers as the flag path would state them; the
// shared builder then does what it does for the flags.
export function toGatewayTargetInput(values: GatewayTargetFormValues): GatewayTargetShortcutInput {
  const isEndpoint = values.kind === "endpoint";
  const isOauth = values.auth === "oauth";
  const scopes = values.scopes.split(/[\s,]+/).filter((scope) => scope !== "");
  return {
    gateway: values.gateway,
    name: values.name,
    endpoint: isEndpoint ? values.endpoint : undefined,
    runtime: isEndpoint ? undefined : values.runtime,
    runtimeEndpoint: isEndpoint ? undefined : values.runtimeEndpoint,
    outboundAuth: {
      type: isOauth ? "oauth" : values.auth === "none" ? "none" : undefined,
      credentialName: isOauth ? values.credential : undefined,
      scopes: isOauth && scopes.length > 0 ? scopes : undefined,
    },
  };
}

function summaryOf(values: GatewayTargetFormValues): Record<string, string> {
  const isEndpoint = values.kind === "endpoint";
  return {
    gateway: values.gateway,
    target: values.name,
    kind: isEndpoint ? "MCP server" : "Runtime",
    ...(isEndpoint
      ? { endpoint: values.endpoint }
      : { runtime: values.runtime, "runtime endpoint": values.runtimeEndpoint ?? "DEFAULT" }),
    "outbound auth":
      values.auth === "oauth"
        ? `OAuth · ${values.credential}`
        : values.auth === "iam"
          ? "Gateway IAM role"
          : "none",
    ...(values.auth === "oauth"
      ? { scopes: toGatewayTargetInput(values).outboundAuth.scopes?.join(", ") ?? "(none)" }
      : {}),
  };
}

export function AddGatewayTargetScreen({ ctx, core }: ScreenProps) {
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
        <AddGatewayTargetWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddGatewayTargetWizard({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  /** The command\'s resolved region, for the China gate of a project without targets. */
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const gateways = project.spec.agentCoreGateways ?? [];
  const runtimes = project.spec.runtimes;
  // Only OAuth credentials can back a shortcut Target's outbound auth.
  const credentials: Choice<string>[] = project.spec.credentials
    .filter((credential) => credential.authorizerType === "OAuthCredentialProvider")
    .map((credential) => ({
      value: credential.name,
      label: credential.name,
      description: "OAuth 2.0 credential provider",
    }));

  const [values, setValues] = useState<GatewayTargetFormValues>({
    gateway: gateways[0]?.name ?? "",
    kind: "endpoint",
    endpoint: "",
    runtime: runtimes[0]?.name ?? "",
    runtimeEndpoint: undefined,
    name: "",
    auth: authChoices("endpoint")[0]!.value,
    credential: credentials[0]?.value ?? "",
    scopes: "",
  });
  const set = (update: Partial<GatewayTargetFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const gateway = gateways.find((candidate) => candidate.name === values.gateway);
  const runtime = runtimes.find((candidate) => candidate.name === values.runtime);
  const isRuntime = values.kind === "runtime";
  const isOauth = values.auth === "oauth";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddGatewayTargetInput(project, toGatewayTargetInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding Target ${values.name}…`}
      successLabel={`added Target '${values.name}' to Gateway '${values.gateway}' in '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="gateway" prompt="which Gateway should this Target hang off?">
        <ResourceChoiceField
          choices={gatewayChoices(gateways)}
          value={values.gateway}
          onChange={(name) => {
            const next = gateways.find((candidate) => candidate.name === name);
            // A kind the new Gateway cannot take falls back to the one every
            // Gateway takes, with the auth default that goes with it.
            set(
              acceptsRuntimeTargets(next) || values.kind === "endpoint"
                ? { gateway: name }
                : { gateway: name, kind: "endpoint", auth: authChoices("endpoint")[0]!.value },
            );
          }}
          emptyMessage="no Gateways in this project"
          emptyHint="add one with  agentcore add gateway"
        />
      </Step>

      <Step stepKey="kind" prompt="what is the Target?">
        <RevealChoiceField
          help={
            acceptsRuntimeTargets(gateway)
              ? ""
              : `Gateway '${values.gateway}' has protocolType MCP, so it takes MCP servers only; a Runtime Target needs a Gateway with protocolType None`
          }
          choices={kindChoices(gateway)}
          value={values.kind}
          onChange={(kind) => set({ kind, auth: authChoices(kind)[0]!.value })}
          input={{
            // The endpoint exists for an MCP server only, so it is asked under
            // that row; a Runtime continues to its own picker.
            opensFor: (kind) => kind === "endpoint",
            label: "Endpoint",
            name: "endpoint",
            help: "an HTTPS URL the Gateway can reach",
            placeholder: "https://mcp.example.com/mcp",
            value: values.endpoint,
            onChange: (endpoint) => set({ endpoint }),
            required: true,
            schema: HttpsEndpointSchema,
          }}
        />
      </Step>

      {isRuntime && (
        <Step stepKey="runtime" prompt="which Runtime?">
          <ResourceChoiceField
            choices={runtimeChoices(runtimes)}
            value={values.runtime}
            onChange={(name) => set({ runtime: name, runtimeEndpoint: undefined })}
            emptyMessage="no Runtimes in this project"
            emptyHint="add one with  agentcore add runtime"
          />
        </Step>
      )}

      {isRuntime && runtime !== undefined && Object.keys(runtime.endpoints ?? {}).length > 0 && (
        <Step stepKey="runtime-endpoint" title="endpoint" prompt="which endpoint on the Runtime?">
          <ChoiceField
            choices={runtimeEndpointChoices(runtime)}
            value={values.runtimeEndpoint}
            onChange={(runtimeEndpoint) => set({ runtimeEndpoint })}
          />
        </Step>
      )}

      <Step stepKey="name" prompt="what should this Target be called?">
        <TextField
          label="Target name"
          help="unique across every Gateway in this project"
          placeholder="search"
          value={values.name}
          onChange={(name) => set({ name })}
          required
        />
      </Step>

      <Step stepKey="auth" prompt="how should the Gateway authenticate to it?">
        <ChoiceField
          choices={authChoices(values.kind)}
          value={values.auth}
          onChange={(auth) => set({ auth })}
        />
      </Step>

      {isOauth && (
        <Step stepKey="credential" prompt="which OAuth credential should it use?">
          {credentials.length === 0 ? (
            <ResourceEmptyState
              message="no OAuth credentials in this project"
              hint="add one with  agentcore add credentials oauth"
            />
          ) : (
            <RevealChoiceField
              choices={credentials}
              value={values.credential}
              onChange={(credential) => set({ credential })}
              input={{
                // Scopes go with whichever credential is chosen, and may be
                // left empty.
                opensFor: () => true,
                label: "Scopes",
                name: "scopes",
                help: "optional · separate several with spaces or commas",
                placeholder: "read write",
                value: values.scopes,
                onChange: (scopes) => set({ scopes }),
              }}
            />
          )}
        </Step>
      )}

      <Step stepKey="review" prompt="this Target will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
