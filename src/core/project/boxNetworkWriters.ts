/**
 * The writers of the Box network model. Each writer declares the outputs it owns and returns the
 * edits for exactly those, which {@link boxNetworkEdits} applies in order to one copy of
 * agentcore.json: changes to agentcore.json, files, and `.env.local` entries. One output belongs
 * to one writer, and {@link boxNetworkEdits} refuses two writers that declare it.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
import {
  addBoxGatewayTargets,
  BOX_BEDROCK_POLICY_FILE,
  BOX_MEMORY_POLICY_FILE,
  boxBedrockPolicy,
  boxMemoryPolicy,
} from "./boxMemory";
import { planBoxProfileCredentials, type BoxKeySources } from "./boxProfileCredentials";
import type { BoxEnvRoute } from "./boxProfileEgress";
import {
  boxTelemetryPolicy,
  boxTelemetryPolicyFile,
  placeBoxTelemetryPolicy,
} from "./boxTelemetry";
import {
  AGENTCORE_CODEZIP_PACK_PATH,
  AGENTCORE_PACK_PATH,
  boxAwsDir,
  boxLocalDir,
  boxLocalProfileFile,
  renderAgentCoreCodeZipPack,
  renderAgentCorePack,
} from "./templates/boxProfile";
import { isTable } from "./runtimeProfile/projectPaths";
import { serializeRuntimeProfile } from "./runtimeProfile/serialize";
import { RUNTIME_INPUTS, type TomlTable } from "./runtimeProfile/types";
import { ProjectStateError } from "../../errors/errors";

/** Something exactly one writer owns. */
export type BoxNetworkOutput =
  | { readonly kind: "gatewayTargets"; readonly gateway: string }
  | { readonly kind: "defaultTargets" }
  | { readonly kind: "credentials" }
  | { readonly kind: "runtimePolicies" }
  | { readonly kind: "envLocal" }
  | { readonly kind: "file"; readonly path: string };

/**
 * A file a writer writes, by its path from the project root: its text, or a byte copy. Or a file
 * that a writer wrote before and removes now.
 */
export type BoxNetworkFile =
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly copyOf: string }
  | { readonly path: string; readonly remove: true };

/** What a writer changes. */
export interface BoxNetworkEdits {
  /** Changes to the copy of agentcore.json, in order; each returns its step messages. */
  readonly spec?: readonly ((spec: ProjectSpec) => string[])[];
  readonly files?: readonly BoxNetworkFile[];
  /** Entries for `.env.local`; each replaces the value it holds under that key. */
  readonly envLocal?: readonly EnvLocalEntry[];
}

/** What a writer reads besides the models: the project, and where build looks for each key. */
export interface BoxNetworkWriteContext extends BoxKeySources {
  readonly spec: ProjectSpec;
  readonly projectRoot: string;
}

export interface BoxNetworkWriter {
  readonly name: string;
  readonly writes: (
    networks: readonly BoxNetwork[],
    context: BoxNetworkWriteContext,
  ) => readonly BoxNetworkOutput[];
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
    for (const output of writer.writes(networks, context)) {
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

/**
 * Writes each file under `projectRoot`: its text, or a byte copy of the project file it names. A
 * file to remove goes when it exists.
 */
export function writeBoxNetworkFiles(projectRoot: string, files: readonly BoxNetworkFile[]): void {
  for (const file of files) {
    const to = join(projectRoot, ...file.path.split("/"));
    if ("remove" in file) {
      if (existsSync(to)) unlinkSync(to);
      continue;
    }
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
 * The `bedrock` and `agentcore` targets that each box runtime's model and Memory calls take, and
 * the Bedrock and Memory policies of the gateways' role, as `addBoxGatewayTargets` adds them.
 */
export const defaultTargetsWriter: BoxNetworkWriter = {
  name: "default targets",
  writes: () => [
    { kind: "defaultTargets" },
    { kind: "file", path: BOX_BEDROCK_POLICY_FILE },
    { kind: "file", path: BOX_MEMORY_POLICY_FILE },
  ],
  edits: (networks, { spec }) => {
    // Every network of one build has the region build builds for.
    const region = networks[0]?.region;
    return {
      spec: [(copy) => addBoxGatewayTargets(copy, region)],
      files: [
        { path: BOX_BEDROCK_POLICY_FILE, policy: boxBedrockPolicy(spec) },
        {
          path: BOX_MEMORY_POLICY_FILE,
          policy: region === undefined ? undefined : boxMemoryPolicy(spec, region),
        },
      ].flatMap(({ path, policy }) =>
        policy ? [{ path, text: `${JSON.stringify(policy, undefined, 2)}\n` }] : [],
      ),
    };
  },
};

/**
 * For each box runtime, the policy that lets its execution role send the CloudWatch telemetry of
 * its own box profile, and the entry in that runtime's `additionalPolicies`. Every other runtime,
 * and a runtime with no CloudWatch target, gets neither, and loses the file and the entry it had.
 */
export const telemetryPolicyWriter: BoxNetworkWriter = {
  name: "telemetry policy",
  writes: (_networks, { spec }) => [
    { kind: "runtimePolicies" },
    ...spec.runtimes.map(({ name }) => ({
      kind: "file" as const,
      path: boxTelemetryPolicyFile(name),
    })),
  ],
  edits: (networks, { spec, projectRoot }) => {
    // Each box runtime reads its own .box/<name>/local profile, so each one gets the policy of its
    // own telemetry only.
    const files: BoxNetworkFile[] = [];
    const boxed: string[] = [];
    for (const { name } of spec.runtimes) {
      const network = networks.find(({ runtime }) => runtime === name);
      const policy = boxTelemetryPolicy(network?.telemetry ?? []);
      const path = boxTelemetryPolicyFile(name);
      if (policy) {
        boxed.push(name);
        files.push({ path, text: `${JSON.stringify(policy, undefined, 2)}\n` });
      } else {
        files.push({ path, remove: true });
      }
    }
    return { spec: [(copy) => placeBoxTelemetryPolicy(copy, projectRoot, boxed)], files };
  },
};

/**
 * Writes a copy of `files`, what the runtime profile writer wrote into the staged folder `dist` of
 * `runtime`, into the runtime's `.box/<name>/aws/` folder, so people can read the AgentCore
 * Runtime profile that deploys. The folder gets nothing else: the box release is only in `dist`.
 */
export function writeRenderedBoxFiles(
  projectRoot: string,
  runtime: string,
  dist: string,
  files: readonly BoxNetworkFile[],
): void {
  const aws = boxAwsDir(runtime);
  rmSync(join(projectRoot, ...aws.split("/")), { recursive: true, force: true });
  writeBoxNetworkFiles(
    projectRoot,
    files.map((file) => ({ ...file, path: `${aws}/${file.path.slice(dist.length + 1)}` })),
  );
}

/** One runtime's staged folder, from the project root, which holds its AgentCore Runtime profile. */
export interface StagedRuntime {
  readonly runtime: string;
  readonly dist: string;
  /**
   * How the runtime deploys. Both kinds stage the `@box/agentcore` pack; a CodeZip deploy also
   * stages the `@box/agentcore-codezip` pack.
   */
  readonly kind: "container" | "codezip";
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
      staged.flatMap(({ runtime, dist, kind }) => [
        { kind: "file" as const, path: `${dist}/profile.toml` },
        // Both Runtime profiles read the deployed resources through this pack.
        { kind: "file" as const, path: `${dist}/${AGENTCORE_PACK_PATH}` },
        // The CodeZip Runtime also reads its Python and code paths through this one.
        ...(kind === "codezip"
          ? [{ kind: "file" as const, path: `${dist}/${AGENTCORE_CODEZIP_PACK_PATH}` }]
          : []),
        ...(networkOf(networks, runtime)?.policyFiles ?? []).map((file) => ({
          kind: "file" as const,
          path: `${dist}/${file}`,
        })),
      ]),
    edits: (networks, { spec }) => ({
      files: staged.flatMap(({ runtime, dist, kind }) => {
        const network = networkOf(networks, runtime);
        const entry = spec.runtimes.find(({ name }) => name === runtime) ?? { name: runtime };
        return [
          { path: `${dist}/profile.toml`, text: runtimeProfileText(runtime, network, spec) },
          { path: `${dist}/${AGENTCORE_PACK_PATH}`, text: renderAgentCorePack(spec, entry) },
          ...(kind === "codezip"
            ? [
                {
                  path: `${dist}/${AGENTCORE_CODEZIP_PACK_PATH}`,
                  text: renderAgentCoreCodeZipPack(),
                },
              ]
            : []),
          ...(network?.policyFiles ?? []).map((file) => ({
            path: `${dist}/${file}`,
            copyOf: `${boxLocalDir(runtime)}/${file}`,
          })),
        ];
      }),
    }),
  };
}

/**
 * The text of the AgentCore Runtime profile of `runtime`, which build derived from its local box
 * profile into the Box network model (`BoxNetwork.runtimeProfile`).
 */
function runtimeProfileText(
  runtime: string,
  network: BoxNetwork | undefined,
  spec: ProjectSpec,
): string {
  if (network?.runtimeProfile === undefined) {
    throw new ProjectStateError(
      `runtime "${runtime}" runs its agent in a box, but build has no AgentCore Runtime profile ` +
        `for it: it derives that profile from ${boxLocalProfileFile(runtime)}, and found no ` +
        "Box network for the runtime, or a Box network with no derived profile. Check that its " +
        "Box gateway is in agentcore.json and that the profile is there, then retry.",
    );
  }
  return serializeRuntimeProfile(
    withoutUnsentRoutes(network.runtimeProfile, network, spec),
    network.runtimeProfileHeader,
  );
}

/**
 * `profile` with no `[egress]` route and no `[mcp]` server to the target of a host that sends an
 * API key that agentcore.json holds no credential for: the gateway targets writer writes no such
 * target (writeGatewayTargets), and says so.
 */
function withoutUnsentRoutes(
  profile: Readonly<TomlTable>,
  network: BoxNetwork,
  spec: ProjectSpec,
): TomlTable {
  const unsent = new Set(
    network.hosts.flatMap((host) =>
      host.target !== undefined && undeclaredKey(spec, host) !== undefined
        ? [`${RUNTIME_INPUTS.gatewayUrl}/${host.target}`]
        : [],
    ),
  );
  const result: TomlTable = { ...profile };
  if (unsent.size === 0) return result;
  const routesToUnsent = (entry: unknown) =>
    isTable(entry) &&
    Array.isArray(entry.backends) &&
    entry.backends.some((backend) => isTable(backend) && unsent.has(backend.url as string));
  for (const key of ["egress", "mcp"]) {
    const table = profile[key];
    if (!isTable(table)) continue;
    const kept = Object.fromEntries(
      Object.entries(table).filter(([, entry]) => !routesToUnsent(entry)),
    );
    if (Object.keys(kept).length > 0) result[key] = kept;
    else delete result[key];
  }
  return result;
}

/** The writers that build and deploy run before synth, in order. */
export const BOX_NETWORK_WRITERS: readonly BoxNetworkWriter[] = [
  credentialsWriter,
  gatewayTargetsWriter,
  defaultTargetsWriter,
  telemetryPolicyWriter,
];
