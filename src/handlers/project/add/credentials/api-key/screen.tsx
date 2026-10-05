import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Step, Summary, TextField, Wizard } from "../../../../../components/wizard";
import { CredentialNameSchema } from "../../../../../projectSchemas/credential";
import { ProjectKey } from "../../../../../router";
import type { ScreenProps } from "../../../../types";
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
import { toAddApiKeyCredentialInput } from "./index";
import { RegionKey } from "../../../../keys";

const BREADCRUMB = ["agentcore", "add", "credentials", "api-key"];
const DESCRIPTION = "add an API key credential provider to the current project";
const CREDENTIALS_MENU = "/agentcore/add/credentials";

type ApiKeyFormValues = CredentialSecretFormValues & {
  name: string;
};

function summaryOf(values: ApiKeyFormValues): Record<string, string> {
  return {
    credential: values.name,
    ...credentialSecretSummary(values),
  };
}

export function AddApiKeyCredentialScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(CREDENTIALS_MENU)}
    >
      {(project) => (
        <AddApiKeyCredentialWizard project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddApiKeyCredentialWizard({
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
  const [values, setValues] = useState<ApiKeyFormValues>({
    name: "",
    ...INITIAL_CREDENTIAL_SECRET_VALUES,
  });
  const set = (update: Partial<ApiKeyFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(CREDENTIALS_MENU)}
      onSubmit={async function* () {
        const secret = await resolveCredentialSecret("api-key", values);
        const credential = toAddApiKeyCredentialInput({
          name: values.name,
          apiKey: secret.value,
          secretRef: secret.secretRef,
        });
        const updated = yield* core.projectManager.addResource(
          project,
          toAddCredentialInput(project, credential),
          { region },
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
          placeholder="service-key"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={CredentialNameSchema}
          live
        />
      </Step>

      {credentialSecretSteps({
        material: "key",
        filePrompt: "which file holds the key?",
        fileLabel: "API key file",
        filePlaceholder: "secrets/service-key.txt",
        jsonKeyHelp: "the property containing the API key",
        jsonKeyPlaceholder: "apiKey",
        values,
        onChange: set,
      })}

      <Step stepKey="review" prompt="this credential will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
