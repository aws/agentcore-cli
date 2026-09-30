import type { SecretReference } from "../../../../projectSchemas/credential";
import { SourceResolver } from "../../../../io";
import {
  ChoiceField,
  MultiTextField,
  PathField,
  Step,
  type Choice,
} from "../../../../components/wizard";

export type CredentialSecretSource = "file" | "secret-reference";

export type CredentialSecretFormValues = {
  source: CredentialSecretSource;
  file: string;
  secretArn: string;
  jsonKey: string;
};

export const INITIAL_CREDENTIAL_SECRET_VALUES: CredentialSecretFormValues = {
  source: "file",
  file: "",
  secretArn: "",
  jsonKey: "",
};

export function credentialSecretSummary(
  values: CredentialSecretFormValues,
): Record<string, string> {
  return values.source === "file"
    ? { source: "local file", file: values.file }
    : {
        source: "Secrets Manager",
        "secret ARN": values.secretArn,
        "JSON key": values.jsonKey,
      };
}

export async function resolveCredentialSecret(
  flagName: string,
  values: CredentialSecretFormValues,
): Promise<{ value?: string; secretRef?: SecretReference }> {
  if (values.source === "secret-reference") {
    return {
      secretRef: {
        secretId: values.secretArn,
        jsonKey: values.jsonKey,
      },
    };
  }

  return {
    value: await new SourceResolver({}).resolveSecret(flagName, `file://${values.file}`),
  };
}

export interface CredentialSecretStepsProps {
  material: string;
  filePrompt: string;
  fileLabel: string;
  filePlaceholder: string;
  jsonKeyHelp: string;
  jsonKeyPlaceholder: string;
  values: CredentialSecretFormValues;
  onChange: (update: Partial<CredentialSecretFormValues>) => void;
}

export function credentialSecretSteps({
  material,
  filePrompt,
  fileLabel,
  filePlaceholder,
  jsonKeyHelp,
  jsonKeyPlaceholder,
  values,
  onChange,
}: CredentialSecretStepsProps) {
  const choices: Choice<CredentialSecretSource>[] = [
    {
      value: "file",
      label: "in a local file",
      description: `read the ${material} from a file and store it in agentcore/.env.local`,
    },
    {
      value: "secret-reference",
      label: "already in Secrets Manager",
      description: "record the secret ARN and JSON key without reading its value",
    },
  ];

  return [
    <Step key="source" stepKey="source" prompt={`where is the ${material}?`}>
      <ChoiceField
        choices={choices}
        value={values.source}
        onChange={(source) => onChange({ source })}
      />
    </Step>,
    values.source === "file" ? (
      <Step key="file" stepKey="file" prompt={filePrompt}>
        <PathField
          label={fileLabel}
          help="relative to the current directory or absolute · the contents are never shown"
          placeholder={filePlaceholder}
          value={values.file}
          onChange={(file) => onChange({ file })}
          required
        />
      </Step>
    ) : (
      <Step key="secret" stepKey="secret" prompt="which secret?">
        <MultiTextField
          inputs={[
            {
              key: "arn",
              label: "Secret ARN",
              placeholder: "arn:aws:secretsmanager:region:account:secret:name",
              value: values.secretArn,
              onChange: (secretArn) => onChange({ secretArn }),
              required: true,
            },
            {
              key: "json-key",
              label: "JSON key",
              help: jsonKeyHelp,
              placeholder: jsonKeyPlaceholder,
              value: values.jsonKey,
              onChange: (jsonKey) => onChange({ jsonKey }),
              required: true,
            },
          ]}
        />
      </Step>
    ),
  ];
}
