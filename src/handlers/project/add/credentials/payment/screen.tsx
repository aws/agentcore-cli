import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Box, Text } from "ink";
import { useNavigate } from "react-router";
import z from "zod";
import {
  ChoiceField,
  MultiTextField,
  ReadableFilePathSchema,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
  type TextInputSpec,
} from "../../../../../components/wizard";
import { CredentialNameSchema } from "../../../../../projectSchemas/credential";
import type { PaymentProvider } from "../../../../../projectSchemas/payment";
import { ProjectKey } from "../../../../../router";
import type { ScreenProps } from "../../../../types";
import { ProjectGate, projectQueryKey } from "../../../ProjectGate";
import type { Project } from "../../../types";
import { credentialSetupNotes, toAddCredentialInput } from "../shared";
import { toAddPaymentCredentialInput, type PaymentCredentialInput } from "./index";
import type { PaymentCredentialInputFlags } from "./input";
import { validatePaymentIdentifier } from "./validation";

const BREADCRUMB = ["agentcore", "add", "credentials", "payment"];
const DESCRIPTION = "add a payment credential provider to the current project";
const CREDENTIALS_MENU = "/agentcore/add/credentials";

const PROVIDER_CHOICES: Choice<PaymentProvider>[] = [
  {
    value: "CoinbaseCDP",
    label: "CoinbaseCDP",
    description: "Coinbase Developer Platform payment credentials",
  },
  {
    value: "StripePrivy",
    label: "StripePrivy",
    description: "Stripe payment authorization with Privy credentials",
  },
];

function identifierSchema(name: string) {
  return z.string().superRefine((value, ctx) => {
    const validation = validatePaymentIdentifier(name, value.trim());
    if (validation !== true) ctx.addIssue({ code: "custom", message: validation });
  });
}

const ApiKeyIdSchema = identifierSchema("apiKeyId");
const AppIdSchema = identifierSchema("appId");
const AuthorizationIdSchema = identifierSchema("authorizationId");

type PaymentFormValues = {
  name: string;
  provider: PaymentProvider;
  apiKeyId: string;
  apiKeySecretFile: string;
  walletSecretFile: string;
  appId: string;
  appSecretFile: string;
  authorizationKeyFile: string;
  authorizationId: string;
};

function fileSource(path: string): string | undefined {
  return path === "" ? undefined : `file://${path}`;
}

function paymentFlags(values: PaymentFormValues): PaymentCredentialInputFlags {
  return values.provider === "CoinbaseCDP"
    ? {
        "api-key-id": values.apiKeyId || undefined,
        "api-key-secret": fileSource(values.apiKeySecretFile),
        "wallet-secret": fileSource(values.walletSecretFile),
      }
    : {
        "app-id": values.appId || undefined,
        "app-secret": fileSource(values.appSecretFile),
        "authorization-private-key": fileSource(values.authorizationKeyFile),
        "authorization-id": values.authorizationId || undefined,
      };
}

function paymentInput(values: PaymentFormValues): PaymentCredentialInput {
  return {
    name: values.name,
    provider: values.provider,
    flags: paymentFlags(values),
  };
}

function shown(value: string): string {
  return value || "(not provided)";
}

function summaryOf(values: PaymentFormValues): Record<string, string> {
  return {
    credential: values.name,
    provider: values.provider,
    ...(values.provider === "CoinbaseCDP"
      ? {
          "API key ID": shown(values.apiKeyId),
          "API key secret file": shown(values.apiKeySecretFile),
          "wallet secret file": shown(values.walletSecretFile),
        }
      : {
          "app ID": shown(values.appId),
          "app secret file": shown(values.appSecretFile),
          "authorization key file": shown(values.authorizationKeyFile),
          "authorization ID": shown(values.authorizationId),
        }),
  };
}

export function AddPaymentCredentialScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(CREDENTIALS_MENU)}
    >
      {(project) => <AddPaymentCredentialWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddPaymentCredentialWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [successNotes, setSuccessNotes] = useState<string[]>([]);
  const [values, setValues] = useState<PaymentFormValues>({
    name: "",
    provider: "CoinbaseCDP",
    apiKeyId: "",
    apiKeySecretFile: "",
    walletSecretFile: "",
    appId: "",
    appSecretFile: "",
    authorizationKeyFile: "",
    authorizationId: "",
  });
  const set = (update: Partial<PaymentFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(CREDENTIALS_MENU)}
      onSubmit={async function* () {
        const credential = await toAddPaymentCredentialInput(paymentInput(values));
        setSuccessNotes(credentialSetupNotes(credential));
        const updated = yield* core.projectManager.addResource(
          project,
          toAddCredentialInput(project, credential),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding credential ${values.name}…`}
      successLabel={`added credential '${values.name}' to '${project.name}'`}
      successNotes={successNotes}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(CREDENTIALS_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this credential provider be called?">
        <TextField
          label="Credential name"
          help="letters, digits, hyphens, and underscores (3-128 characters)"
          placeholder="payments"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={CredentialNameSchema}
          live
        />
      </Step>

      <Step stepKey="provider" prompt="which payment provider?">
        <ChoiceField
          choices={PROVIDER_CHOICES}
          value={values.provider}
          onChange={(provider) => set({ provider })}
        />
      </Step>

      {values.provider === "CoinbaseCDP" ? (
        <Step stepKey="coinbase" prompt="what are the CoinbaseCDP credentials?">
          <PaymentFields
            inputs={[
              {
                key: "api-key-id",
                label: "API key ID",
                placeholder: "coinbase-api-key-id",
                value: values.apiKeyId,
                onChange: (apiKeyId) => set({ apiKeyId }),
                schema: ApiKeyIdSchema,
              },
              {
                key: "api-key-secret",
                label: "API key secret file",
                placeholder: "secrets/coinbase-api-key.txt",
                value: values.apiKeySecretFile,
                onChange: (apiKeySecretFile) => set({ apiKeySecretFile }),
                schema: ReadableFilePathSchema,
              },
              {
                key: "wallet-secret",
                label: "Wallet secret file",
                placeholder: "secrets/coinbase-wallet-key.txt",
                value: values.walletSecretFile,
                onChange: (walletSecretFile) => set({ walletSecretFile }),
                schema: ReadableFilePathSchema,
              },
            ]}
          />
        </Step>
      ) : (
        <Step stepKey="stripe" prompt="what are the StripePrivy credentials?">
          <PaymentFields
            inputs={[
              {
                key: "app-id",
                label: "App ID",
                placeholder: "privy-app-id",
                value: values.appId,
                onChange: (appId) => set({ appId }),
                schema: AppIdSchema,
              },
              {
                key: "app-secret",
                label: "App secret file",
                placeholder: "secrets/privy-app-secret.txt",
                value: values.appSecretFile,
                onChange: (appSecretFile) => set({ appSecretFile }),
                schema: ReadableFilePathSchema,
              },
              {
                key: "authorization-key",
                label: "Authorization key file",
                placeholder: "secrets/stripe-authorization-key.txt",
                value: values.authorizationKeyFile,
                onChange: (authorizationKeyFile) => set({ authorizationKeyFile }),
                schema: ReadableFilePathSchema,
              },
              {
                key: "authorization-id",
                label: "Authorization ID",
                placeholder: "authorization-id",
                value: values.authorizationId,
                onChange: (authorizationId) => set({ authorizationId }),
                schema: AuthorizationIdSchema,
              },
            ]}
          />
        </Step>
      )}

      <Step stepKey="review" prompt="this credential will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

function PaymentFields({ inputs }: { inputs: TextInputSpec[] }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        all fields are optional · secret values must come from readable files and are never shown
      </Text>
      <MultiTextField inputs={inputs} />
    </Box>
  );
}
