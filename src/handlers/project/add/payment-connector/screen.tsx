import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  ChoiceField,
  ResourceChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import type { PaymentCredential } from "../../../../projectSchemas/credential";
import {
  PaymentConnectorNameSchema,
  type PaymentManager,
} from "../../../../projectSchemas/payment";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import type { Project } from "../../types";
import { toAddPaymentConnectorInput, type PaymentConnectorInput } from "./index";

const BREADCRUMB = ["agentcore", "add", "payment-connector"];
const DESCRIPTION = "add a connector to a project payment manager";
const ADD_MENU = "/agentcore/add";

type Provisioning = "quick-create" | "credential";

const PROVISIONING_CHOICES: Choice<Provisioning>[] = [
  {
    value: "quick-create",
    label: "Quick Create a CoinbaseCDP connector",
    description: "provision and authorize a new CoinbaseCDP connector during deploy",
  },
  {
    value: "credential",
    label: "reuse a payment credential",
    description: "use a CoinbaseCDP or StripePrivy credential from this project",
  },
];

type PaymentConnectorFormValues = {
  manager: string;
  name: string;
  provisioning: Provisioning;
  credential: string;
};

function managerChoices(managers: readonly PaymentManager[]): Choice<string>[] {
  return managers.map((manager) => ({
    value: manager.name,
    label: manager.name,
    description: `${manager.connectors.length} ${
      manager.connectors.length === 1 ? "connector" : "connectors"
    }`,
  }));
}

function credentialChoices(credentials: readonly PaymentCredential[]): Choice<string>[] {
  return credentials.map((credential) => ({
    value: credential.name,
    label: credential.name,
    description: `${credential.provider} payment credential`,
  }));
}

export function toPaymentConnectorInput(values: PaymentConnectorFormValues): PaymentConnectorInput {
  if (values.provisioning === "quick-create") {
    return {
      managerName: values.manager,
      name: values.name,
      quickCreate: true,
    };
  }
  return {
    managerName: values.manager,
    name: values.name,
    credentialName: values.credential,
  };
}

function summaryOf(
  values: PaymentConnectorFormValues,
  credentials: readonly PaymentCredential[],
): Record<string, string> {
  const credential = credentials.find((candidate) => candidate.name === values.credential);
  const reusesCredential = values.provisioning === "credential";
  return {
    "payment manager": values.manager,
    connector: values.name,
    provisioning: reusesCredential ? "reuse a payment credential" : "Quick Create",
    provider: reusesCredential ? (credential?.provider ?? "") : "CoinbaseCDP",
    ...(reusesCredential ? { credential: values.credential } : {}),
  };
}

export function AddPaymentConnectorScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => <AddPaymentConnectorWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddPaymentConnectorWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const managers = project.spec.payments ?? [];
  const credentials = project.spec.credentials.filter(
    (credential): credential is PaymentCredential =>
      credential.authorizerType === "PaymentCredentialProvider",
  );
  const [values, setValues] = useState<PaymentConnectorFormValues>({
    manager: managers[0]?.name ?? "",
    name: "",
    provisioning: "quick-create",
    credential: credentials[0]?.name ?? "",
  });
  const set = (update: Partial<PaymentConnectorFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const reusesCredential = values.provisioning === "credential";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddPaymentConnectorInput(project, toPaymentConnectorInput(values)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding payment connector ${values.name}…`}
      successLabel={`added payment connector '${values.name}' to manager '${values.manager}' in '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="manager" prompt="which payment manager?">
        <ResourceChoiceField
          choices={managerChoices(managers)}
          value={values.manager}
          onChange={(manager) => set({ manager })}
          emptyMessage="no payment managers in this project"
          emptyHint="add one with  agentcore add payment-manager"
        />
      </Step>

      <Step stepKey="name" prompt="what should this connector be called?">
        <TextField
          label="Name"
          help="letters, digits, and underscores, starting with a letter (max 48)"
          placeholder="coinbase"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={PaymentConnectorNameSchema}
          live
        />
      </Step>

      <Step stepKey="provisioning" prompt="how should it be provisioned?">
        <ChoiceField
          choices={PROVISIONING_CHOICES}
          value={values.provisioning}
          onChange={(provisioning) => set({ provisioning })}
        />
      </Step>

      {reusesCredential && (
        <Step stepKey="credential" prompt="which credential?">
          <ResourceChoiceField
            choices={credentialChoices(credentials)}
            value={values.credential}
            onChange={(credential) => set({ credential })}
            emptyMessage="no payment credentials in this project"
            emptyHint="add one with  agentcore add credentials payment"
          />
        </Step>
      )}

      <Step stepKey="review" prompt="this connector will be added to agentcore.json">
        <Summary items={summaryOf(values, credentials)} />
      </Step>
    </Wizard>
  );
}
