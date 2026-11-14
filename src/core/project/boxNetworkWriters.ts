/**
 * The writers of the Box network model. Each writer declares the outputs it owns and returns pure
 * edits for exactly those: changes to agentcore.json, files, and `.env.local` entries. One output
 * belongs to one writer, and {@link boxNetworkEdits} refuses two writers that declare it.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getBoxGatewayEntry } from "../../handlers/project/shortcuts";
import type { EnvLocalEntry } from "../../handlers/project/types";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import type { ProjectSpec } from "../../projectSchemas/project";
import { gatewayTargetFor, isManagedTarget, type BoxNetwork } from "./boxNetwork";
import { addBoxGatewayTargets, BOX_MEMORY_POLICY_FILE, boxMemoryPolicy } from "./boxMemory";
import { addBoxEgressCredentials, boxProfileCredentialEnvEntries } from "./boxProfileCredentials";
import { renderRuntimeBoxProfile } from "./templates/boxProfile";

/** Something exactly one writer owns. */
export type BoxNetworkOutput =
  | { readonly kind: "gatewayTargets"; readonly gateway: string }
  | { readonly kind: "defaultTargets" }
  | { readonly kind: "projectType" }
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

/** What a writer reads besides the models. */
export interface BoxNetworkWriteContext {
  readonly spec: ProjectSpec;
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
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
  readonly files: readonly BoxNetworkFile[];
  readonly envLocal: readonly EnvLocalEntry[];
  readonly messages: readonly string[];
}

/**
 * Runs each writer on the models: refuses two writers that declare one output, as a programmer
 * error, then applies every change of agentcore.json to one copy of `context.spec`.
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
  return {
    spec,
    specChanged: !isDeepStrictEqual(spec, context.spec),
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
 * lacks gets one at the end, and every target build does not manage stays. Returns the step
 * messages.
 */
function writeGatewayTargets(spec: ProjectSpec, network: BoxNetwork): string[] {
  const served = network.hosts.flatMap((host) =>
    host.target === undefined || !isManagedTarget({ name: host.target })
      ? []
      : [{ ...host, target: host.target }],
  );
  let gateway = spec.agentCoreGateways.find(({ name }) => name === network.gateway);
  const existing = gateway?.targets ?? [];
  const messages: string[] = [];
  const targets: AgentCoreGatewayTarget[] = [];
  for (const target of existing) {
    if (!isManagedTarget(target)) {
      targets.push(target);
      continue;
    }
    const host = served.find((candidate) => candidate.target === target.name);
    if (!host) {
      messages.push(
        `removing target '${target.name}' from gateway '${network.gateway}' in agentcore.json: ` +
          "Box allows no request to its host in .box/profile.toml",
      );
      continue;
    }
    const written = gatewayTargetFor(host);
    if (!isDeepStrictEqual(written, target)) {
      messages.push(
        `updating target '${target.name}' of gateway '${network.gateway}' in agentcore.json, ` +
          `for ${host.authority}`,
      );
    }
    targets.push(written);
  }
  for (const host of served) {
    if (existing.some(({ name }) => name === host.target)) continue;
    targets.push(gatewayTargetFor(host));
    messages.push(
      `adding target '${host.target}' to gateway '${network.gateway}' in agentcore.json, ` +
        `for ${host.authority}`,
    );
  }
  if (messages.length === 0) return [];
  if (!gateway) {
    gateway = getBoxGatewayEntry(network.runtime);
    spec.agentCoreGateways.push(gateway);
    messages.unshift(`adding gateway '${network.gateway}' to agentcore.json`);
  }
  gateway.targets = targets;
  return messages;
}

/** The API key credentials the box profile's `env://` routes need, and their `.env.local` keys. */
export const credentialsWriter: BoxNetworkWriter = {
  name: "credentials",
  writes: () => [{ kind: "credentials" }, { kind: "envLocal" }],
  edits: (networks, { env }) => {
    const needed = uniqueCredentials(networks);
    return {
      spec: [(spec) => addBoxEgressCredentials(spec, needed)],
      envLocal: boxProfileCredentialEnvEntries(needed, env),
    };
  },
};

function uniqueCredentials(networks: readonly BoxNetwork[]) {
  const needed: { name: string; variable: string }[] = [];
  for (const credential of networks.flatMap((network) => network.credentials)) {
    if (!needed.some(({ name }) => name === credential.name)) needed.push({ ...credential });
  }
  return needed;
}

/**
 * The `bedrock` and `agentcore` targets that each box runtime's model and Memory calls take, and
 * the Memory policy of the gateways' role, as `addBoxGatewayTargets` adds them.
 */
export const defaultTargetsWriter: BoxNetworkWriter = {
  name: "default targets",
  writes: () => [
    { kind: "defaultTargets" },
    { kind: "projectType" },
    { kind: "file", path: BOX_MEMORY_POLICY_FILE },
  ],
  edits: (_networks, { spec, projectRoot }) => {
    const policy = boxMemoryPolicy(spec, projectRoot);
    return {
      spec: [(copy) => addBoxGatewayTargets(copy, projectRoot)],
      files: policy
        ? [{ path: BOX_MEMORY_POLICY_FILE, text: `${JSON.stringify(policy, undefined, 2)}\n` }]
        : [],
    };
  },
};

/** One runtime's staged folder, from the project root, which holds its AgentCore Runtime profile. */
export interface StagedRuntime {
  readonly runtime: string;
  readonly dist: string;
}

/**
 * The AgentCore Runtime box profile of each staged runtime, and a byte copy of each policy file
 * its profile names, beside it at the same path.
 */
export function runtimeProfileWriter(staged: readonly StagedRuntime[]): BoxNetworkWriter {
  const networkOf = (networks: readonly BoxNetwork[], runtime: string) =>
    networks.find((network) => network.runtime === runtime);
  return {
    name: "runtime profile",
    writes: (networks) =>
      staged.flatMap(({ runtime, dist }) => [
        { kind: "file" as const, path: `${dist}/profile.toml` },
        ...(networkOf(networks, runtime)?.policyFiles ?? []).map((file) => ({
          kind: "file" as const,
          path: `${dist}/${file}`,
        })),
      ]),
    edits: (networks, { spec }) => ({
      files: staged.flatMap(({ runtime, dist }) => {
        const network = networkOf(networks, runtime);
        const entry = spec.runtimes.find(({ name }) => name === runtime)!;
        return [
          { path: `${dist}/profile.toml`, text: renderRuntimeBoxProfile(spec, entry, network) },
          ...(network?.policyFiles ?? []).map((file) => ({
            path: `${dist}/${file}`,
            copyOf: `.box/${file}`,
          })),
        ];
      }),
    }),
  };
}

/** The writers that build and deploy run before synth, in order. */
export const BOX_NETWORK_WRITERS: readonly BoxNetworkWriter[] = [
  gatewayTargetsWriter,
  credentialsWriter,
  defaultTargetsWriter,
];
