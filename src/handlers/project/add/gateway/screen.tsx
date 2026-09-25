import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import z from "zod";
import { FormTextInput } from "../../../../components/FormTextInput";
import { darkTheme } from "../../../../components/ui/_core.js";
import {
  ChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  useKeyHints,
  useWizard,
  type Choice,
} from "../../../../components/wizard";
import {
  CustomJwtAuthorizerConfigSchema,
  OidcDiscoveryUrlSchema,
  type GatewayAuthorizerType,
} from "../../../../projectSchemas/auth";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import { GatewayNameSchema } from "../../../../projectSchemas/runtime";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { LoadingFrame, ProjectGate, projectQueryKey } from "../../ProjectGate";
import { requireDeployedNameFits } from "../shared";
import { toAddGatewayInput, type GatewayInput } from "./index";

const theme = darkTheme;
const BREADCRUMB = ["agentcore", "add", "gateway"];
const DESCRIPTION = "add a Gateway to the current project";
const ADD_MENU = "/agentcore/add";

const AUTHORIZER_CHOICES: Choice<GatewayAuthorizerType>[] = [
  {
    value: "NONE",
    label: "NONE (default)",
    description: "allow unauthenticated inbound calls",
  },
  {
    value: "AWS_IAM",
    label: "AWS_IAM",
    description: "require SigV4-signed requests",
  },
  {
    value: "CUSTOM_JWT",
    label: "CUSTOM_JWT",
    description: "validate tokens from your OIDC provider",
  },
];

const SEMANTIC_SEARCH_CHOICES: Choice<boolean>[] = [
  {
    value: false,
    label: "off (default)",
    description: "list tools exactly as Targets expose them",
  },
  {
    value: true,
    label: "on",
    description: "restrict the Gateway to MCP Targets and search tools by meaning",
  },
];

interface GatewayFormValues {
  name: string;
  authorizerType: GatewayAuthorizerType;
  discoveryUrl: string;
  allowedClients: string;
  enableSemanticSearch: boolean;
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function customJwtConfiguration(values: GatewayFormValues) {
  return {
    customJwtAuthorizer: {
      discoveryUrl: values.discoveryUrl.trim(),
      allowedClients: splitCommaList(values.allowedClients),
    },
  };
}

export function toGatewayInput(values: GatewayFormValues): GatewayInput {
  const isCustomJwt = values.authorizerType === "CUSTOM_JWT";
  return {
    name: values.name.trim(),
    protocolType: values.enableSemanticSearch ? "MCP" : undefined,
    authorizerType: values.authorizerType,
    authorizerConfiguration: isCustomJwt ? customJwtConfiguration(values) : undefined,
    enableSemanticSearch: values.enableSemanticSearch || undefined,
  };
}

function summaryOf(values: GatewayFormValues): Record<string, string> {
  const clients = splitCommaList(values.allowedClients);
  return {
    gateway: values.name.trim(),
    authorizer: values.authorizerType,
    ...(values.authorizerType === "CUSTOM_JWT"
      ? {
          issuer: values.discoveryUrl.trim(),
          "allowed clients": clients.join(", "),
        }
      : {}),
    "semantic search": values.enableSemanticSearch ? "on" : "off",
    protocol: values.enableSemanticSearch ? "MCP" : "None",
  };
}

function targetsQueryKey(project: Project) {
  return ["project-targets", project.rootPath] as const;
}

export function AddGatewayScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => <AddGatewayLoader project={project} core={core} />}
    </ProjectGate>
  );
}

function AddGatewayLoader({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const targets = useQuery({
    queryKey: targetsQueryKey(project),
    queryFn: () => core.projectManager.listTargets(project),
  });

  if (targets.data !== undefined) {
    return <AddGatewayWizard project={project} targets={targets.data} core={core} />;
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

function AddGatewayWizard({
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
  const [values, setValues] = useState<GatewayFormValues>({
    name: "",
    authorizerType: "NONE",
    discoveryUrl: "",
    allowedClients: "",
    enableSemanticSearch: false,
  });
  const set = (update: Partial<GatewayFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const nameSchema = useMemo(
    () =>
      GatewayNameSchema.superRefine((name, ctx) => {
        try {
          requireDeployedNameFits("Gateway", project.name, name, "-", 100, targets);
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
          toAddGatewayInput(project, targets, toGatewayInput(values)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding Gateway ${values.name.trim()}…`}
      successLabel={`added Gateway '${values.name.trim()}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this Gateway be called?">
        <TextField
          label="Gateway name"
          help="letters, digits, hyphens and underscores; the deployed <project>-<target>-<name> must fit 100 characters"
          placeholder="tools"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      <Step stepKey="authorizer" prompt="how should inbound callers authenticate?">
        <ChoiceField
          choices={AUTHORIZER_CHOICES}
          value={values.authorizerType}
          onChange={(authorizerType) => set({ authorizerType })}
        />
      </Step>

      {values.authorizerType === "CUSTOM_JWT" && (
        <Step stepKey="jwt" title="JWT" prompt="configure the OIDC issuer">
          <CustomJwtField
            discoveryUrl={values.discoveryUrl}
            allowedClients={values.allowedClients}
            onChange={(update) => set(update)}
          />
        </Step>
      )}

      <Step stepKey="search" prompt="enable semantic search over this Gateway's tools?">
        <ChoiceField
          choices={SEMANTIC_SEARCH_CHOICES}
          value={values.enableSemanticSearch}
          onChange={(enableSemanticSearch) => set({ enableSemanticSearch })}
        />
      </Step>

      <Step stepKey="review" prompt="this Gateway will be added to agentcore.json">
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

function CustomJwtField({
  discoveryUrl,
  allowedClients,
  onChange,
}: {
  discoveryUrl: string;
  allowedClients: string;
  onChange: (
    update: Pick<GatewayFormValues, "discoveryUrl"> | Pick<GatewayFormValues, "allowedClients">,
  ) => void;
}) {
  const { advance, back } = useWizard();
  const [focused, setFocused] = useState<"discovery" | "clients">("discovery");
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "switch field" },
    { key: "enter", label: "continue" },
  ]);

  useInput((_input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setFocused("discovery");
      setError(undefined);
      return;
    }
    if (key.downArrow) {
      setFocused("clients");
      setError(undefined);
      return;
    }
    if (!key.return) return;

    const discoveryIssue = firstIssue(OidcDiscoveryUrlSchema, discoveryUrl.trim());
    if (discoveryIssue !== undefined) {
      setFocused("discovery");
      setError(discoveryIssue);
      return;
    }
    if (focused === "discovery") {
      setFocused("clients");
      setError(undefined);
      return;
    }

    const configIssue = firstIssue(
      CustomJwtAuthorizerConfigSchema,
      customJwtConfiguration({
        name: "",
        authorizerType: "CUSTOM_JWT",
        discoveryUrl,
        allowedClients,
        enableSemanticSearch: false,
      }).customJwtAuthorizer,
    );
    if (configIssue !== undefined) {
      setError(configIssue);
      return;
    }

    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      <FormTextInput
        name="discovery URL"
        helpText="HTTPS URL ending in /.well-known/openid-configuration"
        placeholder="https://idp.example.com/.well-known/openid-configuration"
        errorText=""
        value={discoveryUrl}
        onChange={(value) => {
          onChange({ discoveryUrl: value });
          setError(undefined);
        }}
        focused={focused === "discovery"}
      />
      <FormTextInput
        name="allowed clients"
        helpText="one or more OAuth client IDs, separated by commas"
        placeholder="agentcore-cli, internal-tools"
        errorText=""
        value={allowedClients}
        onChange={(value) => {
          onChange({ allowedClients: value });
          setError(undefined);
        }}
        focused={focused === "clients"}
      />
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}
