import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import z from "zod";
import { FormRadioGroup, type FormRadioOption } from "../../../../components/FormRadioGroup";
import { FormTextInput } from "../../../../components/FormTextInput";
import { darkTheme } from "../../../../components/ui/_core.js";
import {
  ChoiceField,
  firstIssue,
  Step,
  Summary,
  TextField,
  useKeyHints,
  useWizard,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import { AllowedScopeSchema, OidcDiscoveryUrlSchema } from "../../../../projectSchemas/auth";
import {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentManagerNameSchema,
  PaymentSpendLimitSchema,
  type PaymentAuthorizerType,
} from "../../../../projectSchemas/payment";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import type { Project } from "../../types";
import { splitCommaList } from "../traffic-source-fields";
import { paymentManagerNotes, toAddPaymentManagerInput, type PaymentManagerInput } from "./index";
import { RegionKey } from "../../../keys";

const theme = darkTheme;
const BREADCRUMB = ["agentcore", "add", "payment-manager"];
const DESCRIPTION = "add a payment manager to the current project";
const ADD_MENU = "/agentcore/add";

const AUTHORIZER_CHOICES: Choice<PaymentAuthorizerType>[] = [
  {
    value: "AWS_IAM",
    label: "AWS_IAM (default)",
    description: "require SigV4-signed payment requests",
  },
  {
    value: "CUSTOM_JWT",
    label: "CUSTOM_JWT",
    description: "validate bearer tokens from an OIDC provider",
  },
];

const AUTO_PAYMENT_CHOICES: Choice<boolean>[] = [
  {
    value: true,
    label: "yes (default)",
    description: "settle payment requests automatically",
  },
  {
    value: false,
    label: "no",
    description: "require payment requests to be settled manually",
  },
];

type PaymentManagerFormValues = {
  name: string;
  authorizerType: PaymentAuthorizerType;
  discoveryUrl: string;
  allowedClients: string;
  allowedAudience: string;
  allowedScopes: string;
  autoPayment: boolean;
  defaultSpendLimit: string;
};

const AllowedScopesFieldSchema = z.string().superRefine((value, ctx) => {
  for (const scope of splitCommaList(value)) {
    const result = AllowedScopeSchema.safeParse(scope);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: result.error.issues[0]?.message ?? "Invalid JWT scope",
      });
      return;
    }
  }
});

function optionalCommaList(value: string): string[] | undefined {
  const entries = splitCommaList(value);
  return entries.length === 0 ? undefined : entries;
}

export function toPaymentManagerInput(values: PaymentManagerFormValues): PaymentManagerInput {
  const isCustomJwt = values.authorizerType === "CUSTOM_JWT";
  return {
    name: values.name,
    authorizerType: values.authorizerType,
    discoveryUrl: isCustomJwt ? values.discoveryUrl.trim() : undefined,
    allowedClients: isCustomJwt ? optionalCommaList(values.allowedClients) : undefined,
    allowedAudience: isCustomJwt ? optionalCommaList(values.allowedAudience) : undefined,
    allowedScopes: isCustomJwt ? optionalCommaList(values.allowedScopes) : undefined,
    autoPayment: values.autoPayment,
    defaultSpendLimit: values.defaultSpendLimit,
  };
}

function summaryOf(values: PaymentManagerFormValues): Record<string, string> {
  const input = toPaymentManagerInput(values);
  return {
    "payment manager": values.name,
    authorizer: values.authorizerType,
    ...(values.authorizerType === "CUSTOM_JWT"
      ? {
          "discovery URL": input.discoveryUrl!,
          "allowed clients": input.allowedClients?.join(", ") ?? "(any)",
          "allowed audiences": input.allowedAudience?.join(", ") ?? "(any)",
          "allowed scopes": input.allowedScopes?.join(", ") ?? "(any)",
        }
      : {}),
    "auto payment": values.autoPayment ? "yes" : "no",
    "spend limit": values.defaultSpendLimit,
  };
}

export function AddPaymentManagerScreen({ ctx, core }: ScreenProps) {
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
        <AddPaymentManagerWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddPaymentManagerWizard({
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
  const [values, setValues] = useState<PaymentManagerFormValues>({
    name: "",
    authorizerType: "AWS_IAM",
    discoveryUrl: "",
    allowedClients: "",
    allowedAudience: "",
    allowedScopes: "",
    autoPayment: DEFAULT_AUTO_PAYMENT,
    defaultSpendLimit: DEFAULT_SPEND_LIMIT,
  });
  const set = (update: Partial<PaymentManagerFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const isCustomJwt = values.authorizerType === "CUSTOM_JWT";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddPaymentManagerInput(toPaymentManagerInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding payment manager ${values.name}…`}
      successLabel={`added payment manager '${values.name}' to '${project.name}'`}
      successNotes={paymentManagerNotes(
        values.name,
        values.autoPayment,
        project.spec.runtimes.length > 0,
      )}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this payment manager be called?">
        <TextField
          label="Name"
          help="letters and digits, starting with a letter (max 48)"
          placeholder="payments"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={PaymentManagerNameSchema}
          live
        />
      </Step>

      <Step stepKey="authorizer" prompt="how should payment callers authenticate?">
        <AuthorizerField
          authorizerType={values.authorizerType}
          discoveryUrl={values.discoveryUrl}
          onChange={(update) => set(update)}
        />
      </Step>

      {isCustomJwt && (
        <Step
          stepKey="jwt-options"
          title="JWT options"
          prompt="restrict accepted JWTs? optional · separate multiple values with commas"
        >
          <JwtOptionsField
            allowedClients={values.allowedClients}
            allowedAudience={values.allowedAudience}
            allowedScopes={values.allowedScopes}
            onChange={(update) => set(update)}
          />
        </Step>
      )}

      <Step stepKey="auto-payment" prompt="settle payment requests automatically?">
        <ChoiceField
          choices={AUTO_PAYMENT_CHOICES}
          value={values.autoPayment}
          onChange={(autoPayment) => set({ autoPayment })}
        />
      </Step>

      <Step stepKey="spend-limit" title="spend limit" prompt="what per-session spend limit?">
        <TextField
          label="Spend limit"
          help="a non-negative decimal amount"
          value={values.defaultSpendLimit}
          onChange={(defaultSpendLimit) => set({ defaultSpendLimit })}
          required
          schema={PaymentSpendLimitSchema}
        />
      </Step>

      <Step stepKey="review" prompt="this payment manager will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

function AuthorizerField({
  authorizerType,
  discoveryUrl,
  onChange,
}: {
  authorizerType: PaymentAuthorizerType;
  discoveryUrl: string;
  onChange: (
    update: Partial<Pick<PaymentManagerFormValues, "authorizerType" | "discoveryUrl">>,
  ) => void;
}) {
  const { advance, back } = useWizard();
  const index = AUTHORIZER_CHOICES.findIndex((choice) => choice.value === authorizerType);
  const [editingDiscoveryUrl, setEditingDiscoveryUrl] = useState(false);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "enter", label: "continue" },
  ]);

  useInput((_input, key) => {
    if (!editingDiscoveryUrl) {
      if (key.escape) {
        back();
        return;
      }
      if (key.upArrow || key.downArrow) {
        const nextIndex = key.upArrow
          ? Math.max(0, index - 1)
          : Math.min(AUTHORIZER_CHOICES.length - 1, index + 1);
        onChange({ authorizerType: AUTHORIZER_CHOICES[nextIndex]!.value });
        setError(undefined);
        return;
      }
      if (key.return) {
        if (authorizerType === "CUSTOM_JWT") setEditingDiscoveryUrl(true);
        else advance();
      }
      return;
    }

    if (key.escape || key.upArrow) {
      setEditingDiscoveryUrl(false);
      setError(undefined);
      return;
    }
    if (!key.return) return;

    const issue = firstIssue(OidcDiscoveryUrlSchema, discoveryUrl.trim());
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    setError(undefined);
    advance();
  });

  const options: FormRadioOption[] = AUTHORIZER_CHOICES.map(({ label, description }) => ({
    label,
    description: description ?? "",
  }));

  return (
    <Box flexDirection="column">
      <FormRadioGroup
        helpText=""
        options={options}
        focusedIndex={editingDiscoveryUrl ? undefined : index}
        selectedIndex={index}
      />
      {editingDiscoveryUrl && authorizerType === "CUSTOM_JWT" && (
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
        />
      )}
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

function JwtOptionsField({
  allowedClients,
  allowedAudience,
  allowedScopes,
  onChange,
}: {
  allowedClients: string;
  allowedAudience: string;
  allowedScopes: string;
  onChange: (
    update: Partial<
      Pick<PaymentManagerFormValues, "allowedClients" | "allowedAudience" | "allowedScopes">
    >,
  ) => void;
}) {
  const { advance, back } = useWizard();
  const [focusedField, setFocusedField] = useState(0);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "enter", label: "continue" },
  ]);

  useInput((_input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setFocusedField((current) => Math.max(0, current - 1));
      setError(undefined);
      return;
    }
    if (key.downArrow) {
      setFocusedField((current) => Math.min(2, current + 1));
      setError(undefined);
      return;
    }
    if (!key.return) return;

    if (focusedField < 2) {
      setFocusedField(focusedField + 1);
      setError(undefined);
      return;
    }

    const issue = firstIssue(AllowedScopesFieldSchema, allowedScopes);
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      <FormTextInput
        name="allowed clients"
        helpText=""
        placeholder="agentcore-cli, internal-tools"
        errorText=""
        value={allowedClients}
        onChange={(value) => {
          onChange({ allowedClients: value });
          setError(undefined);
        }}
        focused={focusedField === 0}
      />
      <FormTextInput
        name="allowed audiences"
        helpText=""
        placeholder="payments, checkout"
        errorText=""
        value={allowedAudience}
        onChange={(value) => {
          onChange({ allowedAudience: value });
          setError(undefined);
        }}
        focused={focusedField === 1}
      />
      <FormTextInput
        name="allowed scopes"
        helpText=""
        placeholder="pay, refund"
        errorText=""
        value={allowedScopes}
        onChange={(value) => {
          onChange({ allowedScopes: value });
          setError(undefined);
        }}
        focused={focusedField === 2}
      />
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}
