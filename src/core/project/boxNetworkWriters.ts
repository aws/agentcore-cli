/**
 * The writers of the Box network model. Each writer declares the outputs it owns and returns pure
 * edits for exactly those: changes to agentcore.json, files, and `.env.local` entries. One output
 * belongs to one writer, and {@link boxNetworkEdits} refuses two writers that declare it.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { EnvLocalEntry } from "../../handlers/project/types";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import type { ProjectSpec } from "../../projectSchemas/project";
import {
  boxGatewayOf,
  gatewayTargetFor,
  hostKey,
  isManagedTarget,
  parseEndpoint,
  type BoxNetwork,
  type BoxNetworkHost,
} from "./boxNetwork";
import { addBoxMemoryTarget, BOX_MEMORY_POLICY_FILE, boxMemoryPolicy } from "./boxMemory";
import { planBoxProfileCredentials, type BoxKeySources } from "./boxProfileCredentials";
import type { BoxEnvRoute } from "./boxProfileEgress";

/** Something exactly one writer owns. */
export type BoxNetworkOutput =
  | { readonly kind: "gatewayTargets"; readonly gateway: string }
  | { readonly kind: "defaultTargets" }
  | { readonly kind: "credentials" }
  | { readonly kind: "envLocal" }
  | { readonly kind: "file"; readonly path: string };

/** A file a writer writes, by its path from the project root: its text, or a byte copy. */
export type BoxNetworkFile =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly copyOf: string };

/** What a writer changes. */
export interface BoxNetworkEdits {
  /** Changes to the copy of agentcore.json, in order; each returns its step messages. */
  readonly spec?: readonly ((spec: ProjectSpec) => string[])[];
  readonly files?: readonly BoxNetworkFile[];
  /** Entries for `.env.local`, which keep any value it holds already. */
  readonly envLocal?: readonly EnvLocalEntry[];
}

/** What a writer reads besides the models: the project, and where build looks for each key. */
export interface BoxNetworkWriteContext extends BoxKeySources {
  readonly spec: ProjectSpec;
  readonly projectRoot: string;
}

export interface BoxNetworkWriter {
  readonly name: string;
  readonly writes: (networks: readonly BoxNetwork[]) => readonly BoxNetworkOutput[];
  readonly edits: (
    networks: readonly BoxNetwork[],
    context: BoxNetworkWriteContext,
  ) => BoxNetworkEdits;
}

/** The edits of every writer, with agentcore.json changed once on a copy of the spec. */
export interface CollectedEdits {
  readonly spec: ProjectSpec;
  /** Whether any writer changed agentcore.json. */
  readonly specChanged: boolean;
  /** The fields of agentcore.json that the writers changed. */
  readonly changedFields: readonly (keyof ProjectSpec)[];
  readonly files: readonly BoxNetworkFile[];
  readonly envLocal: readonly EnvLocalEntry[];
  readonly messages: readonly string[];
}

/**
 * Runs each writer on the models: refuses two writers that declare one output, as a programmer
 * error, then applies every change of agentcore.json to one copy of `context.spec`, in the order
 * of `writers`.
 */
export function boxNetworkEdits(
  writers: readonly BoxNetworkWriter[],
  networks: readonly BoxNetwork[],
  context: BoxNetworkWriteContext,
): CollectedEdits {
  const owners = new Map<string, string>();
  for (const writer of writers) {
    for (const output of writer.writes(networks)) {
      const key = JSON.stringify(output);
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(`Box network writers '${owner}' and '${writer.name}' both write ${key}`);
      }
      owners.set(key, writer.name);
    }
  }
  const spec = structuredClone(context.spec);
  const messages: string[] = [];
  const files: BoxNetworkFile[] = [];
  const envLocal: EnvLocalEntry[] = [];
  for (const writer of writers) {
    const edits = writer.edits(networks, context);
    for (const change of edits.spec ?? []) messages.push(...change(spec));
    files.push(...(edits.files ?? []));
    envLocal.push(...(edits.envLocal ?? []));
  }
  const changedFields = (Object.keys(spec) as (keyof ProjectSpec)[]).filter(
    (field) => !isDeepStrictEqual(spec[field], context.spec[field]),
  );
  return {
    spec,
    specChanged: changedFields.length > 0,
    changedFields,
    files,
    envLocal,
    messages,
  };
}

/** Writes each file under `projectRoot`: its text, or a byte copy of the project file it names. */
export function writeBoxNetworkFiles(projectRoot: string, files: readonly BoxNetworkFile[]): void {
  for (const file of files) {
    const to = join(projectRoot, ...file.path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    if ("text" in file) writeFileSync(to, file.text);
    else copyFileSync(join(projectRoot, ...file.copyOf.split("/")), to);
  }
}

/**
 * The API key credential of each `env://` route that a target sends, and its key in `.env.local`,
 * as {@link planBoxProfileCredentials} plans them. It runs before the gateway targets writer, which
 * writes a target that sends an API key only when its credential is in agentcore.json.
 */
export const credentialsWriter: BoxNetworkWriter = {
  name: "credentials",
  writes: () => [{ kind: "credentials" }, { kind: "envLocal" }],
  edits: (networks, { spec, env, envLocal }) => {
    const plan = planBoxProfileCredentials(structuredClone(spec), uniqueRoutes(networks), {
      env,
      envLocal,
    });
    return {
      spec: [
        (copy) => {
          copy.credentials.push(...plan.added);
          return plan.messages;
        },
      ],
      envLocal: plan.entries,
    };
  },
};

function uniqueRoutes(networks: readonly BoxNetwork[]): BoxEnvRoute[] {
  const routes: BoxEnvRoute[] = [];
  for (const route of networks.flatMap((network) => network.envRoutes)) {
    if (!routes.some((other) => other.route === route.route)) routes.push(route);
  }
  return routes;
}

/** The `egress-` targets of each Box gateway, which build adds, rewrites, and removes. */
export const gatewayTargetsWriter: BoxNetworkWriter = {
  name: "gateway targets",
  writes: (networks) => networks.map(({ gateway }) => ({ kind: "gatewayTargets", gateway })),
  edits: (networks) => ({
    spec: networks.map((network) => (spec: ProjectSpec) => writeGatewayTargets(spec, network)),
  }),
};

/**
 * Sets the build-owned targets of the network's Box gateway: a managed target that a host takes is
 * rewritten in place, every other managed target goes, a host whose managed target the gateway
 * lacks gets one at the end, and every target build does not manage stays. A host whose target
 * sends an API key credential that agentcore.json does not declare gets no target. Returns the
 * step messages.
 */
function writeGatewayTargets(spec: ProjectSpec, network: BoxNetwork): string[] {
  const gateway = boxGatewayOf(spec, network.runtime);
  if (!gateway) return [];
  const served = network.hosts.flatMap((host) =>
    host.target === undefined || !isManagedTarget({ name: host.target })
      ? []
      : [{ ...host, target: host.target }],
  );
  const sent = served.filter((host) => undeclaredKey(spec, host) === undefined);
  const unsent = served.filter((host) => undeclaredKey(spec, host) !== undefined);
  const existing = gateway.targets;
  const messages: string[] = [];
  const targets: AgentCoreGatewayTarget[] = [];
  const gatewayName = `'${gateway.name}'`;
  for (const target of existing) {
    if (!isManagedTarget(target)) {
      targets.push(target);
      continue;
    }
    const host = sent.find((candidate) => candidate.target === target.name);
    if (!host) {
      if (unsent.some((candidate) => candidate.target === target.name)) continue;
      const at = target.passthrough && parseEndpoint(target.passthrough.endpoint);
      messages.push(
        `removing gateway target '${target.name}' from ${gatewayName}: the Box profile no ` +
          `longer allows ${at ? hostKey(at.host, at.port) : "its host"}`,
      );
      continue;
    }
    const written = gatewayTargetFor(host);
    if (!isDeepStrictEqual(written, target)) {
      messages.push(
        `updating gateway target '${target.name}' of ${gatewayName} for ${host.authority}`,
      );
    }
    targets.push(written);
  }
  for (const host of sent) {
    if (existing.some(({ name }) => name === host.target)) continue;
    targets.push(gatewayTargetFor(host));
    messages.push(`adding gateway target '${host.target}' to ${gatewayName} for ${host.authority}`);
  }
  for (const host of unsent) {
    const auth = undeclaredKey(spec, host)!;
    const removed = existing.some(({ name }) => name === host.target);
    messages.push(
      `${removed ? "removing" : "not adding"} gateway target '${host.target}' of ${gatewayName} ` +
        `for ${host.authority}: it sends the key of env://${auth.variable}, and agentcore.json ` +
        `has no API key credential '${auth.credentialName}' to hold it`,
    );
  }
  if (isDeepStrictEqual(targets, existing)) return messages;
  gateway.targets = targets;
  return messages;
}

/** The API key that a host's target sends, when agentcore.json declares no credential for it. */
function undeclaredKey(
  spec: ProjectSpec,
  { outboundAuth: auth }: BoxNetworkHost,
): Extract<BoxNetworkHost["outboundAuth"], { kind: "apiKey" }> | undefined {
  if (auth.kind !== "apiKey") return undefined;
  const declared = spec.credentials.some(
    ({ authorizerType, name }) =>
      authorizerType === "ApiKeyCredentialProvider" && name === auth.credentialName,
  );
  return declared ? undefined : auth;
}

/**
 * The `agentcore` target that each box runtime's Memory calls take, and the Memory policy of the
 * gateways' role, as `addBoxMemoryTarget` adds them.
 */
export const defaultTargetsWriter: BoxNetworkWriter = {
  name: "default targets",
  writes: () => [{ kind: "defaultTargets" }, { kind: "file", path: BOX_MEMORY_POLICY_FILE }],
  edits: (_networks, { spec, projectRoot }) => {
    const policy = boxMemoryPolicy(spec, projectRoot);
    return {
      spec: [(copy) => addBoxMemoryTarget(copy, projectRoot)],
      files: policy
        ? [{ path: BOX_MEMORY_POLICY_FILE, text: `${JSON.stringify(policy, undefined, 2)}\n` }]
        : [],
    };
  },
};

/** The writers that build and deploy run before synth, in order. */
export const BOX_NETWORK_WRITERS: readonly BoxNetworkWriter[] = [
  credentialsWriter,
  gatewayTargetsWriter,
  defaultTargetsWriter,
];
