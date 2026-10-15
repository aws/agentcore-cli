import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ResourceNotFoundException } from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreIdentityClient } from "../../../handlers/identity/types";
import type { MigrationCheck } from "../../../handlers/project/migrate/types";
import type { CoreOptions } from "../../types";
import { DEPLOYED_STATE_RELATIVE_PATH } from "../backends/cdk/deployedState";

/** The Identity reads that report a credential provider's secret ARN. */
export type CredentialSecretLookups = Pick<
  CoreIdentityClient,
  "getApiKeyCredentialProvider" | "getOauth2CredentialProvider"
>;

type RecordedCredential = { credentialProviderArn?: string; clientSecretArn?: string };

type LooseDeployedState = {
  targets?: Record<string, { resources?: { credentials?: Record<string, RecordedCredential> } }>;
};

type LooseSpec = {
  agentCoreGateways?: {
    targets?: { outboundAuth?: { type?: string; credentialName?: string } }[];
  }[];
};

/**
 * The credentials a Gateway target authenticates with (API key or OAuth outbound
 * auth): the only ones v1's CDK app can't synthesize without a secret ARN. Reads a
 * v0 or v1 spec alike, since both name them the same way.
 */
export function gatewayCredentialNames(spec: unknown): Set<string> {
  const names = new Set<string>();
  for (const gateway of (spec as LooseSpec).agentCoreGateways ?? []) {
    for (const target of gateway.targets ?? []) {
      const auth = target.outboundAuth;
      if ((auth?.type === "API_KEY" || auth?.type === "OAUTH") && auth.credentialName) {
        names.add(auth.credentialName);
      }
    }
  }
  return names;
}

/**
 * v1's CDK app grants a Gateway read access to a credential's secret by the ARN
 * deployed-state.json records, but v0 never records it for API key providers and
 * doesn't always for OAuth ones. Looks up each of the target's API key and OAuth
 * credentials recorded without one and returns the deployed state with the ARNs
 * filled in (the file's new contents, only when something was filled in). A
 * credential a Gateway target uses and whose ARN can't be found fails the check;
 * any other is only a warning, since nothing synthesizes from it. No lookups are
 * made when nothing is missing.
 */
export async function backfillCredentialSecrets(input: {
  identity: CredentialSecretLookups;
  rootPath: string;
  /** The spec's credentials, for which kind of provider each one is. */
  credentials: { name: string; authorizerType: string }[];
  /** The credentials a Gateway target uses; see {@link gatewayCredentialNames}. */
  gatewayCredentials: Set<string>;
  target: string;
  options: CoreOptions;
}): Promise<{ deployedState?: string; check?: MigrationCheck; warnings: string[] }> {
  const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
  // Read as written rather than through the schema, so what isn't patched is kept as is.
  const state = JSON.parse(await readFile(statePath, "utf8")) as LooseDeployedState;
  const recorded = state.targets?.[input.target]?.resources?.credentials ?? {};
  const kinds = new Map(input.credentials.map((c) => [c.name, c.authorizerType]));
  const missing = Object.entries(recorded).filter(
    ([name, entry]) =>
      entry.credentialProviderArn !== undefined &&
      entry.clientSecretArn === undefined &&
      (kinds.get(name) === "ApiKeyCredentialProvider" ||
        kinds.get(name) === "OAuthCredentialProvider"),
  );
  if (missing.length === 0) return { warnings: [] };

  const found: string[] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];
  for (const [name, entry] of missing) {
    // The provider's name is the ARN's last segment, whatever naming the v0 release used.
    const provider = entry.credentialProviderArn!.split("/").at(-1)!;
    const apiKey = kinds.get(name) === "ApiKeyCredentialProvider";
    const api = apiKey ? "GetApiKeyCredentialProvider" : "GetOauth2CredentialProvider";
    let reason: string;
    try {
      const secretArn = apiKey
        ? (await input.identity.getApiKeyCredentialProvider(provider, input.options))
            .apiKeySecretArn?.secretArn
        : (await input.identity.getOauth2CredentialProvider(provider, input.options))
            .clientSecretArn?.secretArn;
      if (secretArn !== undefined) {
        entry.clientSecretArn = secretArn;
        found.push(name);
        continue;
      }
      reason = `its provider '${provider}' has no stored secret`;
    } catch (error) {
      reason =
        error instanceof ResourceNotFoundException
          ? `its provider '${provider}' no longer exists in AgentCore Identity; recreate it, or ` +
            "remove the credential from the project"
          : `${api} failed (${(error as Error).message}); check that these credentials can call ` +
            `bedrock-agentcore:${api} in ${input.options.region}`;
    }
    if (input.gatewayCredentials.has(name)) {
      blocking.push(`${name}: ${reason}`);
    } else {
      warnings.push(
        `v0 didn't record the secret ARN of credential ${name}, and it couldn't be found: ` +
          `${reason}. No Gateway target uses it, so migrating doesn't need it.`,
      );
    }
  }

  const name = "credential secrets";
  const recordedMessage =
    `found the secret ARNs v0 didn't record for ${found.join(", ")}; migrating records them ` +
    `in ${DEPLOYED_STATE_RELATIVE_PATH.split("\\").join("/")}`;
  let check: MigrationCheck | undefined;
  if (blocking.length > 0) {
    check = {
      name,
      ok: false,
      message:
        "v0 didn't record the secret ARN v1's CDK app needs to let a Gateway read " +
        `${blocking.length === 1 ? "this credential" : "these credentials"}, and it couldn't ` +
        `be found. ${blocking.join(". ")}. Then run \`agentcore migrate\` again.` +
        (found.length > 0 ? ` The secret ARNs of ${found.join(", ")} were found.` : ""),
    };
  } else if (found.length > 0) {
    check = { name, ok: true, message: recordedMessage };
  }
  return {
    ...(found.length > 0 && { deployedState: `${JSON.stringify(state, null, 2)}\n` }),
    ...(check && { check }),
    warnings,
  };
}
