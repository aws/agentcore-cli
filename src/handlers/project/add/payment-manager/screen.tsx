import { useState } from "react";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import { OidcDiscoveryUrlSchema } from "../../../../projectSchemas/auth";
import {
  DEFAULT_SPEND_LIMIT,
  PaymentManagerNameSchema,
  PaymentSpendLimitSchema,
  type PaymentAuthorizerType,
} from "../../../../projectSchemas/payment";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  ChoiceField,
  Summary,
  blankToUndefined,
  splitList,
} from "../../../../components/wizard";
import {
  RUNTIME_SOURCE_WARNING,
  autoPaymentWarning,
  toAddPaymentManagerInput,
  type PaymentManagerInput,
} from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "payment-manager"];
const DESCRIPTION = "adds a payment manager to the current project";
const ADD_MENU = "/agentcore/project/add";

const AUTHORIZER_CHOICES = [
  {
    value: "AWS_IAM" as PaymentAuthorizerType,
    label: "AWS_IAM (default)",
    description: "SigV4-signed callers",
  },
  {
    value: "CUSTOM_JWT" as PaymentAuthorizerType,
    label: "CUSTOM_JWT",
    description: "your own JWT issuer · asks for its discovery URL",
  },
];

const AUTO_PAYMENT_CHOICES = [
  {
    value: true,
    label: "on (default)",
    description: "agents settle 402 responses themselves, without human approval",
  },
  { value: false, label: "off", description: "every payment waits for manual approval" },
];

interface PaymentManagerFormValues {
  name: string;
  authorizerType: PaymentAuthorizerType;
  discoveryUrl: string;
  allowedClients: string;
  allowedAudience: string;
  allowedScopes: string;
  autoPayment: boolean;
  defaultSpendLimit: string;
  description: string;
}

// toPaymentManagerInput reads the form into the PaymentManagerInput the
// handler's builder expects. JWT answers are passed only under CUSTOM_JWT, so
// a discovery URL typed before switching back to AWS_IAM is dropped rather
// than tripping the "valid only with CUSTOM_JWT" rule.
export function toPaymentManagerInput(values: PaymentManagerFormValues): PaymentManagerInput {
  const isJwt = values.authorizerType === "CUSTOM_JWT";
  return {
    name: values.name.trim(),
    authorizerType: values.authorizerType,
    jwt: isJwt
      ? {
          discoveryUrl: values.discoveryUrl.trim(),
          allowedClients: splitList(values.allowedClients),
          allowedAudience: splitList(values.allowedAudience),
          allowedScopes: splitList(values.allowedScopes),
        }
      : undefined,
    autoPayment: values.autoPayment,
    defaultSpendLimit: blankToUndefined(values.defaultSpendLimit),
    description: blankToUndefined(values.description),
  };
}

function summaryOf(values: PaymentManagerFormValues): Record<string, string> {
  const input = toPaymentManagerInput(values);
  return {
    "payment manager": input.name,
    authorizer: values.authorizerType,
    ...(input.jwt === undefined ? {} : { "discovery url": input.jwt.discoveryUrl ?? "" }),
    ...(input.jwt?.allowedClients === undefined
      ? {}
      : { clients: input.jwt.allowedClients.join(", ") }),
    ...(input.jwt?.allowedAudience === undefined
      ? {}
      : { audience: input.jwt.allowedAudience.join(", ") }),
    ...(input.jwt?.allowedScopes === undefined
      ? {}
      : { scopes: input.jwt.allowedScopes.join(", ") }),
    "auto-payment": values.autoPayment ? "on" : "off",
    "spend limit": input.defaultSpendLimit ?? DEFAULT_SPEND_LIMIT,
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}

// successHintFor carries the warnings the flag path prints after success, so
// the wizard's user is told the same things.
function successHintFor(values: PaymentManagerFormValues, project: Project): string {
  const warnings = [
    ...(values.autoPayment ? [autoPaymentWarning(values.name.trim())] : []),
    ...(project.spec.runtimes.length > 0 ? [RUNTIME_SOURCE_WARNING] : []),
  ];
  return [...warnings, "enter exits"].join("\n");
}

export function AddPaymentManagerScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddPaymentManagerWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddPaymentManagerWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const [values, setValues] = useState<PaymentManagerFormValues>({
    name: "",
    authorizerType: "AWS_IAM",
    discoveryUrl: "",
    allowedClients: "",
    allowedAudience: "",
    allowedScopes: "",
    autoPayment: true,
    defaultSpendLimit: DEFAULT_SPEND_LIMIT,
    description: "",
  });
  const set = (update: Partial<PaymentManagerFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const isJwt = values.authorizerType === "CUSTOM_JWT";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(
          project,
          toAddPaymentManagerInput(toPaymentManagerInput(values)),
        )
      }
      runningLabel={`adding payment manager ${values.name.trim()}…`}
      successLabel={`added payment manager '${values.name.trim()}' to '${project.name}'`}
      successHint={successHintFor(values, project)}
    >
      <Step name="name" question="what should this payment manager be called?">
        <TextField
          label="payment manager name"
          placeholder="payments"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={PaymentManagerNameSchema}
        />
      </Step>

      <Step name="authorizer" question="how should payment requests be authorized?">
        <ChoiceField
          choices={AUTHORIZER_CHOICES}
          value={values.authorizerType}
          onChange={(authorizerType) => set({ authorizerType })}
        />
      </Step>

      {isJwt && (
        <Step
          name="discovery-url"
          title="issuer"
          question="where is your JWT issuer's OIDC discovery document?"
        >
          <TextField
            label="discovery URL"
            placeholder="https://idp.example.com/.well-known/openid-configuration"
            value={values.discoveryUrl}
            onChange={(discoveryUrl) => set({ discoveryUrl })}
            required
            schema={OidcDiscoveryUrlSchema}
          />
        </Step>
      )}

      {isJwt && (
        <Step
          name="allowed-clients"
          title="clients"
          question="which client IDs may pay? (optional)"
        >
          <TextField
            label="allowed clients"
            help="comma-separated; blank accepts any client"
            value={values.allowedClients}
            onChange={(allowedClients) => set({ allowedClients })}
          />
        </Step>
      )}

      {isJwt && (
        <Step
          name="allowed-audience"
          title="audience"
          question="which audiences may pay? (optional)"
        >
          <TextField
            label="allowed audience"
            help="comma-separated; blank accepts any audience"
            value={values.allowedAudience}
            onChange={(allowedAudience) => set({ allowedAudience })}
          />
        </Step>
      )}

      {isJwt && (
        <Step name="allowed-scopes" title="scopes" question="which scopes may pay? (optional)">
          <TextField
            label="allowed scopes"
            help="comma-separated; blank accepts any scope"
            value={values.allowedScopes}
            onChange={(allowedScopes) => set({ allowedScopes })}
          />
        </Step>
      )}

      <Step
        name="auto-payment"
        title="auto-payment"
        question="should agents settle payments on their own?"
      >
        <ChoiceField
          choices={AUTO_PAYMENT_CHOICES}
          value={values.autoPayment}
          onChange={(autoPayment) => set({ autoPayment })}
        />
      </Step>

      <Step
        name="spend-limit"
        title="spend limit"
        question="how much may one payment session spend?"
      >
        <TextField
          label="default spend limit"
          help={`a non-negative amount; blank keeps the default of ${DEFAULT_SPEND_LIMIT}`}
          placeholder={DEFAULT_SPEND_LIMIT}
          value={values.defaultSpendLimit}
          onChange={(defaultSpendLimit) => set({ defaultSpendLimit })}
          schema={PaymentSpendLimitSchema}
        />
      </Step>

      <Step name="description" question="what is this payment manager for? (optional)">
        <TextField
          label="description"
          placeholder="pays for premium data APIs"
          value={values.description}
          onChange={(description) => set({ description })}
        />
      </Step>

      <Step name="review" question="this payment manager will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
