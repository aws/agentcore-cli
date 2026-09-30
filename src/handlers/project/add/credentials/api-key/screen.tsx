import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  ChoiceField,
  MultiTextField,
  PathField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../../components/wizard";
import { SourceResolver } from "../../../../../io";
import { CredentialNameSchema } from "../../../../../projectSchemas/credential";
import { ProjectKey } from "../../../../../router";
import type { ScreenProps } from "../../../../types";
import { ProjectGate, projectQueryKey } from "../../../ProjectGate";
import type { Project } from "../../../types";
import { toAddCredentialInput } from "../shared";
import { toAddApiKeyCredentialInput } from "./index";

const BREADCRUMB = ["agentcore", "add", "credentials", "api-key"];
const DESCRIPTION = "add an API key credential provider to the current project";
const CREDENTIALS_MENU = "/agentcore/add/credentials";

type ApiKeySource = "file" | "secret-reference";

const SOURCE_CHOICES: Choice<ApiKeySource>[] = [
  {
    value: "file",
    label: "in a local file",
    description: "read the key from a file and store it in agentcore/.env.local",
  },
  {
    value: "secret-reference",
    label: "already in Secrets Manager",
    description: "record the secret ARN and JSON key without reading its value",
  },
];

type ApiKeyFormValues = {
  name: string;
  source: ApiKeySource;
  file: string;
  secretArn: string;
  jsonKey: string;
};

function summaryOf(values: ApiKeyFormValues): Record<string, string> {
  const fromFile = values.source === "file";
  return {
    credential: values.name,
    source: fromFile ? "local file" : "Secrets Manager",
    ...(fromFile
      ? { file: values.file }
      : {
          "secret ARN": values.secretArn,
          "JSON key": values.jsonKey,
        }),
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
      {(project) => <AddApiKeyCredentialWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddApiKeyCredentialWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<ApiKeyFormValues>({
    name: "",
    source: "file",
    file: "",
    secretArn: "",
    jsonKey: "",
  });
  const set = (update: Partial<ApiKeyFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const fromFile = values.source === "file";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(CREDENTIALS_MENU)}
      onSubmit={async function* () {
        const apiKey = fromFile
          ? await new SourceResolver({}).resolveSecret("api-key", `file://${values.file}`)
          : undefined;
        const credential = toAddApiKeyCredentialInput(
          fromFile
            ? { name: values.name, apiKey }
            : {
                name: values.name,
                secretRef: { secretId: values.secretArn, jsonKey: values.jsonKey },
              },
        );
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
          placeholder="service-key"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={CredentialNameSchema}
          live
        />
      </Step>

      <Step stepKey="source" prompt="where is the key?">
        <ChoiceField
          choices={SOURCE_CHOICES}
          value={values.source}
          onChange={(source) => set({ source })}
        />
      </Step>

      {fromFile ? (
        <Step stepKey="file" prompt="which file holds the key?">
          <PathField
            label="API key file"
            help="relative to the current directory or absolute · the contents are never shown"
            placeholder="secrets/service-key.txt"
            value={values.file}
            onChange={(file) => set({ file })}
            required
          />
        </Step>
      ) : (
        <Step stepKey="secret" prompt="which secret?">
          <MultiTextField
            inputs={[
              {
                key: "arn",
                label: "Secret ARN",
                placeholder: "arn:aws:secretsmanager:region:account:secret:name",
                value: values.secretArn,
                onChange: (secretArn) => set({ secretArn }),
                required: true,
              },
              {
                key: "json-key",
                label: "JSON key",
                help: "the property containing the API key",
                placeholder: "apiKey",
                value: values.jsonKey,
                onChange: (jsonKey) => set({ jsonKey }),
                required: true,
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
