import { useState } from "react";
import { CredentialProviderVendorType } from "@aws-sdk/client-bedrock-agentcore-control";
import { useQueryClient } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import z from "zod";
import { FormTextArea } from "../../../../../components/FormTextArea";
import { FormTextInput } from "../../../../../components/FormTextInput";
import { darkTheme } from "../../../../../components/ui/_core.js";
import {
  ChoiceField,
  Step,
  Summary,
  TextAreaField,
  TextField,
  Wizard,
  firstIssue,
  useKeyHints,
  useWizard,
  type Choice,
} from "../../../../../components/wizard";
import {
  CredentialNameSchema,
  OAuthCredentialSchema,
} from "../../../../../projectSchemas/credential";
import { ProjectKey } from "../../../../../router";
import type { ScreenProps } from "../../../../types";
import { parseProviderConfigFlags } from "../../../../identity/oauth2-credential-provider/config";
import { ProjectGate, projectQueryKey } from "../../../ProjectGate";
import type { Project } from "../../../types";
import {
  INITIAL_CREDENTIAL_SECRET_VALUES,
  credentialSecretSummary,
  credentialSecretSteps,
  resolveCredentialSecret,
  type CredentialSecretFormValues,
} from "../secret";
import { toAddCredentialInput } from "../shared";
import { toAddOauthCredentialInput, type OauthCredentialInput } from "./index";

const theme = darkTheme;
const BREADCRUMB = ["agentcore", "add", "credentials", "oauth"];
const DESCRIPTION = "add an OAuth2 credential provider to the current project";
const CREDENTIALS_MENU = "/agentcore/add/credentials";
const CUSTOM_VENDOR = "CustomOauth2";

const VENDORED_VENDORS = Object.values(CredentialProviderVendorType)
  .filter((vendor) => vendor !== CUSTOM_VENDOR)
  .sort();

export const OAUTH_VENDOR_CHOICES: Choice<CredentialProviderVendorType>[] = [
  {
    value: CUSTOM_VENDOR,
    label: "a custom provider",
    description: "CustomOauth2 · configure it with a client ID and discovery URL",
  },
  ...VENDORED_VENDORS.map((vendor) => ({ value: vendor, label: vendor })),
];

const DiscoveryUrlSchema = z.string().url("Must be a valid URL");

// This mirrors parseProviderConfigFlags: a complete provider configuration is
// one SDK union member, represented as one object-valued key. Running it
// through the project schema also keeps secret material out of agentcore.json.
const ProviderConfigurationSchema = z
  .record(z.string(), z.unknown())
  .superRefine((configuration, ctx) => {
    const entries = Object.entries(configuration);
    const [, provider] = entries[0] ?? [];
    if (
      entries.length !== 1 ||
      typeof provider !== "object" ||
      provider === null ||
      Array.isArray(provider)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "must contain a single vendor configuration object",
      });
      return;
    }

    const credential = OAuthCredentialSchema.safeParse({
      authorizerType: "OAuthCredentialProvider",
      name: "oauth",
      vendor: "GithubOauth2",
      providerConfig: configuration,
    });
    if (!credential.success) {
      for (const issue of credential.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
  });

type OauthFormValues = CredentialSecretFormValues & {
  name: string;
  vendor: CredentialProviderVendorType;
  clientId: string;
  discoveryUrl: string;
  scopes: string;
  providerConfiguration: string;
};

function scopesOf(value: string): string[] | undefined {
  const scopes = value.split(/[\s,]+/).filter((scope) => scope !== "");
  return scopes.length > 0 ? scopes : undefined;
}

function providerConfigurationOf(value: string): Record<string, unknown> {
  const mode = parseProviderConfigFlags({ providerConfiguration: value });
  if (mode.kind !== "complete") throw new Error("expected complete OAuth provider configuration");
  return mode.config;
}

function toOauthCredentialInput(
  values: OauthFormValues,
  secret: Awaited<ReturnType<typeof resolveCredentialSecret>>,
): OauthCredentialInput {
  if (values.vendor === CUSTOM_VENDOR) {
    return {
      name: values.name,
      vendor: values.vendor,
      clientId: values.clientId === "" ? undefined : values.clientId,
      discoveryUrl: values.discoveryUrl,
      scopes: scopesOf(values.scopes),
      clientSecret: secret.value,
      clientSecretRef: secret.secretRef,
    };
  }

  return {
    name: values.name,
    vendor: values.vendor,
    providerConfig: providerConfigurationOf(values.providerConfiguration),
    clientSecret: secret.value,
    clientSecretRef: secret.secretRef,
  };
}

function summaryOf(values: OauthFormValues): Record<string, string> {
  const custom = values.vendor === CUSTOM_VENDOR;
  return {
    credential: values.name,
    provider: custom ? "a custom provider (CustomOauth2)" : values.vendor,
    ...(custom
      ? {
          "client ID": values.clientId || "(none)",
          "discovery URL": values.discoveryUrl,
          scopes: scopesOf(values.scopes)?.join(", ") ?? "(none)",
        }
      : {
          "provider configuration": values.providerConfiguration,
        }),
    ...credentialSecretSummary(values),
  };
}

function providerConfigurationExample(vendor: CredentialProviderVendorType): string {
  const providerConfigKeys: Partial<Record<CredentialProviderVendorType, string>> = {
    GoogleOauth2: "googleOauth2ProviderConfig",
    GithubOauth2: "githubOauth2ProviderConfig",
    SlackOauth2: "slackOauth2ProviderConfig",
    SalesforceOauth2: "salesforceOauth2ProviderConfig",
    MicrosoftOauth2: "microsoftOauth2ProviderConfig",
    AtlassianOauth2: "atlassianOauth2ProviderConfig",
    LinkedinOauth2: "linkedinOauth2ProviderConfig",
  };
  const key = providerConfigKeys[vendor] ?? "includedOauth2ProviderConfig";
  return `{"${key}":{"clientId":"..."}}`;
}

export function AddOauthCredentialScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(CREDENTIALS_MENU)}
    >
      {(project) => <AddOauthCredentialWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddOauthCredentialWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<OauthFormValues>({
    name: "",
    vendor: CUSTOM_VENDOR,
    clientId: "",
    discoveryUrl: "",
    scopes: "",
    providerConfiguration: "",
    ...INITIAL_CREDENTIAL_SECRET_VALUES,
  });
  const set = (update: Partial<OauthFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const custom = values.vendor === CUSTOM_VENDOR;

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(CREDENTIALS_MENU)}
      onSubmit={async function* () {
        const secret = await resolveCredentialSecret("client-secret", values);
        const credential = toAddOauthCredentialInput(toOauthCredentialInput(values, secret));
        const updated = yield* core.projectManager.addResource(
          project,
          toAddCredentialInput(project, credential),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding credential ${values.name}…`}
      successLabel={`added credential '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(CREDENTIALS_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this credential provider be called?">
        <TextField
          label="Credential name"
          help="letters, digits, hyphens, and underscores (3-128 characters)"
          placeholder="service-oauth"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={CredentialNameSchema}
          live
        />
      </Step>

      <Step stepKey="vendor" prompt="which OAuth2 provider?">
        <ChoiceField
          choices={OAUTH_VENDOR_CHOICES}
          value={values.vendor}
          onChange={(vendor) => set({ vendor })}
          maxVisible={10}
        />
      </Step>

      {custom ? (
        <Step stepKey="custom-config" prompt="how is the custom provider configured?">
          <CustomOauthConfigurationField
            clientId={values.clientId}
            discoveryUrl={values.discoveryUrl}
            scopes={values.scopes}
            onChange={set}
          />
        </Step>
      ) : (
        <Step stepKey="vendored-config" prompt="what is the provider configuration?">
          <TextAreaField
            label="Provider configuration"
            help="complete secret-free Oauth2ProviderConfigInput JSON · enter for a new line, ctrl+d to continue"
            placeholder={providerConfigurationExample(values.vendor)}
            example={providerConfigurationExample(values.vendor)}
            value={values.providerConfiguration}
            onChange={(providerConfiguration) => set({ providerConfiguration })}
            required
            json
            schema={ProviderConfigurationSchema}
          />
        </Step>
      )}

      {credentialSecretSteps({
        material: "client secret",
        filePrompt: "which file holds the client secret?",
        fileLabel: "Client secret file",
        filePlaceholder: "secrets/oauth-client-secret.txt",
        jsonKeyHelp: "the property containing the OAuth client secret",
        jsonKeyPlaceholder: "clientSecret",
        values,
        onChange: set,
      })}

      <Step stepKey="review" prompt="this credential will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

function CustomOauthConfigurationField({
  clientId,
  discoveryUrl,
  scopes,
  onChange,
}: {
  clientId: string;
  discoveryUrl: string;
  scopes: string;
  onChange: (update: Partial<OauthFormValues>) => void;
}) {
  const { advance, back } = useWizard();
  const [focused, setFocused] = useState(0);
  const [error, setError] = useState<string>();

  useKeyHints(
    focused === 2
      ? [
          { key: "↑↓", label: "navigate" },
          { key: "enter", label: "newline" },
          { key: "ctrl+d", label: "continue" },
        ]
      : [
          { key: "↑↓", label: "navigate" },
          { key: "enter", label: "next" },
        ],
  );

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setFocused((current) => Math.max(0, current - 1));
      setError(undefined);
      return;
    }
    if (key.downArrow) {
      setFocused((current) => Math.min(2, current + 1));
      setError(undefined);
      return;
    }
    if (focused === 0 && key.return) {
      setFocused(1);
      return;
    }
    if (focused === 1 && key.return) {
      if (discoveryUrl.trim() === "") {
        setError("Discovery URL is required");
        return;
      }
      const issue = firstIssue(DiscoveryUrlSchema, discoveryUrl);
      if (issue !== undefined) {
        setError(issue);
        return;
      }
      setError(undefined);
      setFocused(2);
      return;
    }
    if (focused === 2 && ((key.ctrl && input === "d") || (key.return && scopes === ""))) {
      setError(undefined);
      advance();
    }
  });

  return (
    <Box flexDirection="column">
      <FormTextInput
        name="Client ID"
        helpText="optional"
        placeholder="client-id"
        errorText=""
        value={clientId}
        onChange={(value) => {
          onChange({ clientId: value });
          setError(undefined);
        }}
        focused={focused === 0}
      />
      <FormTextInput
        name="Discovery URL"
        helpText="required · the provider's OpenID configuration URL"
        placeholder="https://idp.example.com/.well-known/openid-configuration"
        errorText=""
        value={discoveryUrl}
        onChange={(value) => {
          onChange({ discoveryUrl: value });
          setError(undefined);
        }}
        focused={focused === 1}
      />
      <FormTextArea
        name="Scopes"
        helpText="optional · separate with whitespace or commas"
        placeholder="openid email"
        value={scopes}
        onChange={(value) => {
          onChange({ scopes: value });
          setError(undefined);
        }}
        previewLines={4}
        focused={focused === 2}
      />
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}
