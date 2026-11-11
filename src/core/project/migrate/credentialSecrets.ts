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

/** deployed-state.json's path as messages show it, with `/` on every platform. */
const STATE_PATH = DEPLOYED_STATE_RELATIVE_PATH.split("\\").join("/");

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
 * How a target's providers can be read: with options for its account and region,
 * not at all because the active credentials are for another account, or not at
 * all because no credentials could be resolved for its region.
 */
export type TargetAccess = { options: CoreOptions } | { account: string } | { error: string };

/**
 * v1's CDK app grants a Gateway read access to a credential's secret by the ARN
 * deployed-state.json records, but v0 never records it for API key providers and
 * doesn't always for OAuth ones. The app synthesizes every target's stack, so
 * every deployed target needs them: for each target recorded with API key or
 * OAuth credentials missing one, looks them up with the target's access and
 * returns the deployed state with the ARNs filled in (the file's new contents,
 * only when something was filled in). A credential a Gateway target uses and
 * whose ARN can't be found, or can't be looked up because the target is in
 * another account, fails the check; any other is only a warning, since nothing
 * synthesizes from it. Nothing is resolved or looked up when nothing is missing.
 */
export async function backfillCredentialSecrets<
  Target extends { name: string; account: string; region: string },
>(input: {
  identity: CredentialSecretLookups;
  rootPath: string;
  /** The spec's credentials, for which kind of provider each one is. */
  credentials: { name: string; authorizerType: string }[];
  /** The credentials a Gateway target uses; see {@link gatewayCredentialNames}. */
  gatewayCredentials: Set<string>;
  /** The project's deployment targets; those without recorded credentials are skipped. */
  targets: Target[];
  access: (target: Target) => Promise<TargetAccess>;
}): Promise<{ deployedState?: string; check?: MigrationCheck; warnings: string[] }> {
  const statePath = join(input.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
  // Read as written rather than through the schema, so what isn't patched is kept as is.
  const state = JSON.parse(await readFile(statePath, "utf8")) as LooseDeployedState;
  const kinds = new Map(input.credentials.map((c) => [c.name, c.authorizerType]));
  const candidates = input.targets.flatMap((target) => {
    const recorded = state.targets?.[target.name]?.resources?.credentials ?? {};
    const missing = Object.entries(recorded).filter(
      ([name, entry]) =>
        entry.credentialProviderArn !== undefined &&
        entry.clientSecretArn === undefined &&
        (kinds.get(name) === "ApiKeyCredentialProvider" ||
          kinds.get(name) === "OAuthCredentialProvider"),
    );
    return missing.length > 0 ? [{ target, missing }] : [];
  });
  if (candidates.length === 0) return { warnings: [] };
  // Names are qualified by target only when more than one target is involved.
  const label = (name: string, target: string) =>
    candidates.length > 1 ? `${name} (target ${target})` : name;

  const found: string[] = [];
  const failed: string[] = [];
  const otherAccounts: string[] = [];
  const warnings: string[] = [];
  const unneeded = (name: string, reason: string) =>
    warnings.push(
      `v0 didn't record the secret ARN of credential ${name}, and it couldn't be found: ` +
        `${reason}. No Gateway target uses it, so migrating doesn't need it.`,
    );
  for (const { target, missing } of candidates) {
    const access = await input.access(target);
    if ("account" in access) {
      const needed = missing.map(([name]) => name).filter((n) => input.gatewayCredentials.has(n));
      for (const [name] of missing) {
        if (needed.includes(name)) continue;
        unneeded(
          label(name, target.name),
          `target ${target.name} is in account ${target.account}, not the active account ${access.account}`,
        );
      }
      if (needed.length === 0) continue;
      otherAccounts.push(
        `Target ${target.name} is in account ${target.account} (${target.region}), but the ` +
          `active credentials are for account ${access.account}. v1's CDK app synthesizes ` +
          `every target's stack, so it needs the secret ARNs of ${needed.join(", ")} there ` +
          "too, and migrate reads every target with the one set of credentials it runs with. " +
          "Record them by hand: with credentials for that account, run `aws " +
          "bedrock-agentcore-control get-api-key-credential-provider` (or " +
          `get-oauth2-credential-provider) --name <provider> --region ${target.region}, add the ` +
          `secret ARN as clientSecretArn under targets.${target.name}.resources.credentials.` +
          `<name> in ${STATE_PATH}, commit it, then run \`agentcore migrate\` again.`,
      );
      continue;
    }
    for (const [name, entry] of missing) {
      // The provider's name is the ARN's last segment, whatever naming the v0 release used.
      const provider = entry.credentialProviderArn!.split("/").at(-1)!;
      const apiKey = kinds.get(name) === "ApiKeyCredentialProvider";
      const api = apiKey ? "GetApiKeyCredentialProvider" : "GetOauth2CredentialProvider";
      let reason: string;
      if ("error" in access) {
        reason = `no credentials could be resolved for ${target.region} (${access.error})`;
      } else {
        try {
          const secretArn = apiKey
            ? (await input.identity.getApiKeyCredentialProvider(provider, access.options))
                .apiKeySecretArn?.secretArn
            : (await input.identity.getOauth2CredentialProvider(provider, access.options))
                .clientSecretArn?.secretArn;
          if (secretArn !== undefined) {
            entry.clientSecretArn = secretArn;
            found.push(label(name, target.name));
            continue;
          }
          reason = `its provider '${provider}' has no stored secret`;
        } catch (error) {
          reason =
            error instanceof ResourceNotFoundException
              ? `its provider '${provider}' no longer exists in AgentCore Identity; recreate it, ` +
                "or remove the credential from the project"
              : `${api} failed (${(error as Error).message}); check that these credentials can ` +
                `call bedrock-agentcore:${api} in ${target.region}`;
        }
      }
      if (input.gatewayCredentials.has(name)) {
        failed.push(`${label(name, target.name)}: ${reason}`);
      } else {
        unneeded(label(name, target.name), reason);
      }
    }
  }

  const name = "credential secrets";
  const recordedMessage =
    `found the secret ARNs v0 didn't record for ${found.join(", ")}; migrating records them ` +
    `in ${STATE_PATH}`;
  const blocking = [
    ...(failed.length > 0
      ? [
          "v0 didn't record the secret ARN v1's CDK app needs to let a Gateway read " +
            `${failed.length === 1 ? "this credential" : "these credentials"}, and it ` +
            `couldn't be found. ${failed.join(". ")}. Then run \`agentcore migrate\` again.`,
        ]
      : []),
    ...otherAccounts,
  ];
  let check: MigrationCheck | undefined;
  if (blocking.length > 0) {
    check = {
      name,
      ok: false,
      message:
        blocking.join(" ") +
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
