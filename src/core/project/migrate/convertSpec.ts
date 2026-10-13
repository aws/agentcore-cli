import type {
  MigrationProblem,
  PinnedName,
  PinnedResourceType,
} from "../../../handlers/project/migrate/types";
import { DROPPED_FIELDS_WARNING } from "../../../handlers/project/migrate/types";
import { AwsDeploymentTargetsSchema } from "../../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import type { V0DeployedState, V0ProjectSpec } from "../../../projectSchemas/v0";
import { translateV0Spec } from "../legacy/translate";
import { describePath, droppedPaths, problemsFromZodError } from "./issues";
import { pinCollisions } from "./pinCollisions";
import { onlineInsightConfigs } from "./preflight";

type Json = Record<string, unknown>;

/** Project-relative paths shown to users. Always forward slashes, on every platform. */
export const SPEC_RELATIVE_PATH = "agentcore/agentcore.json";
export const AWS_TARGETS_RELATIVE_PATH = "agentcore/aws-targets.json";

export type ConvertedSpec = {
  /** The v1 agentcore.json content: the parsed v1 spec, or the unparsed candidate when it has problems. */
  json: Json;
  pins: PinnedName[];
  warnings: string[];
  /** Why the converted spec doesn't parse as v1 (or a deployed name can't be kept); empty when it does. */
  problems: MigrationProblem[];
  /**
   * Fields v1 drops from resources that are already deployed. Dropping one changes
   * the deployed resource on the next deploy, so each blocks the migration.
   */
  deployedChanges: MigrationProblem[];
};

/** What a harness's harness.json says about the AWS resources v0 created for it. */
export type HarnessFacts = {
  dockerfile?: string;
  containerUri?: string;
  executionRoleArn?: string;
  /**
   * The v0 app passed the library `hasDockerfile` for this harness (v0.16.0 and
   * later set it from the Dockerfile), so the library built its container and ECR
   * repository.
   */
  hasDockerfile?: boolean;
  /** The harness's code location the v0 app passed the library; set only with a Dockerfile. */
  codeLocation?: string;
};

/** What one target recorded about a deployed resource: its ID (or name, or ARN). */
export type Recorded = { target: string; id: string };

type HarnessRecord = Recorded & { roleArn: string; provisioner?: string };

/** The deployed resources a v0 deployed state records, by kind, with the target that recorded each. */
export type DeployedResources = {
  runtimes: Map<string, Recorded[]>;
  memories: Map<string, Recorded[]>;
  evaluators: Map<string, Recorded[]>;
  onlineEvalConfigs: Map<string, Recorded[]>;
  policyEngines: Map<string, Recorded[]>;
  /** Keyed `engine/policy`, as v0 records them. */
  policies: Map<string, Recorded[]>;
  configBundles: Map<string, Recorded[]>;
  /** `id` is the harness ID. */
  harnesses: Map<string, HarnessRecord[]>;
  gateways: Map<string, Recorded[]>;
  /** Credential provider ARNs. */
  credentials: Map<string, Recorded[]>;
  /** Runtime IDs of tool runtimes and gateway-target runtimes, keyed by tool or target name. */
  mcpRuntimes: Map<string, Recorded[]>;
  /** Function names of gateway-target Lambdas, keyed by target name. */
  mcpLambdas: Map<string, Recorded[]>;
};

/**
 * Collects, for every resource any target deployed, what each target recorded
 * about it. Recorded IDs are the resource's AWS name plus a 10-character suffix,
 * which is how kept names are checked against what was actually deployed.
 */
export function deployedResources(state: V0DeployedState): DeployedResources {
  const deployed: DeployedResources = {
    runtimes: new Map(),
    memories: new Map(),
    evaluators: new Map(),
    onlineEvalConfigs: new Map(),
    policyEngines: new Map(),
    policies: new Map(),
    configBundles: new Map(),
    harnesses: new Map(),
    gateways: new Map(),
    credentials: new Map(),
    mcpRuntimes: new Map(),
    mcpLambdas: new Map(),
  };
  for (const [target, { resources }] of Object.entries(state.targets)) {
    if (!resources) continue;
    const add = <T, R extends Recorded>(
      into: Map<string, R[]>,
      entries: Record<string, T> | undefined,
      record: (entry: T) => Omit<R, "target">,
    ) => {
      for (const [name, entry] of Object.entries(entries ?? {})) {
        into.set(name, [...(into.get(name) ?? []), { target, ...record(entry) } as R]);
      }
    };
    add(deployed.runtimes, resources.runtimes, (r) => ({ id: r.runtimeId }));
    add(deployed.memories, resources.memories, (m) => ({ id: m.memoryId }));
    add(deployed.evaluators, resources.evaluators, (e) => ({ id: e.evaluatorId }));
    add(deployed.onlineEvalConfigs, resources.onlineEvalConfigs, (o) => ({
      id: o.onlineEvaluationConfigId,
    }));
    add(deployed.policyEngines, resources.policyEngines, (p) => ({ id: p.policyEngineId }));
    add(deployed.policies, resources.policies, (p) => ({ id: p.policyId }));
    add(deployed.configBundles, resources.configBundles, (b) => ({ id: b.bundleId }));
    add(deployed.harnesses, resources.harnesses, (h) => ({
      id: h.harnessId,
      roleArn: h.roleArn,
      provisioner: h.provisioner,
    }));
    add(deployed.gateways, resources.gateways, (g) => ({ id: g.gatewayId }));
    add(deployed.gateways, resources.mcp?.gateways, (g) => ({ id: g.gatewayId }));
    add(deployed.credentials, resources.credentials, (c) => ({ id: c.credentialProviderArn }));
    add(deployed.mcpRuntimes, resources.mcp?.runtimes, (r) => ({ id: r.runtimeId }));
    add(deployed.mcpLambdas, resources.mcp?.lambdas, (l) => ({ id: l.functionName }));
  }
  return deployed;
}

/** The agentcore.json schema version the v0 CLI wrote, which `migratedFrom` names. */
export const MIGRATED_FROM = "v1";

/**
 * Converts a parsed v0 spec into v1's agentcore.json, marked `migratedFrom: "v1"`
 * so the CDK library keeps v0's physical names for the whole project, and lists
 * the AWS names of everything already deployed (checked against what each target
 * recorded) for the plan to verify the v1 synth against. Never throws for a
 * project v0 accepted: anything v1 rejects is returned as a problem with its
 * field path.
 *
 * `harnesses` carries each harness's harness.json facts (by harness name), which
 * decide whether v0 created an execution role and an ECR repository for it.
 */
export function convertSpec(
  v0: V0ProjectSpec,
  state: V0DeployedState,
  harnesses: Record<string, HarnessFacts> = {},
): ConvertedSpec {
  // The v0-only collections aren't in the translation; they stay on the v0 spec.
  const { spec } = translateV0Spec(v0);
  const { unassignedTargets, abTests } = v0;
  const candidate: Json = { ...(spec as unknown as Json), migratedFrom: MIGRATED_FROM };
  // v1 has no online insights. Preflight blocks a project that uses them; dropping
  // them here lets the rest of the project convert, so one preview reports everything.
  const insights = new Set(onlineInsightConfigs(v0).map((config) => config.name));
  if (insights.size > 0 && Array.isArray(candidate.onlineEvalConfigs)) {
    candidate.onlineEvalConfigs = (candidate.onlineEvalConfigs as Json[]).filter(
      (config) => !insights.has(String(config.name)),
    );
  }
  const warnings: string[] = [];

  if (unassignedTargets?.length) {
    warnings.push(
      `Dropped unassigned gateway targets (${unassignedTargets.map((t) => t.name).join(", ")}): ` +
        "v1 has no unassigned targets. Add them to a gateway with 'agentcore add gateway-target' if you still need them.",
    );
  }
  if (abTests?.length) {
    warnings.push(
      `Removed abTests (${abTests.map((t) => t.name).join(", ")}) from agentcore.json: ` +
        "v1 doesn't track A/B tests there. They stay in AgentCore; manage them with 'agentcore eval ab-test'.",
    );
  }

  const deployed = deployedResources(state);
  const everDeployed = Object.values(state.targets).some(
    ({ resources }) => resources !== undefined,
  );
  const { pins, problems } = pinDeployedNames(v0.name, candidate, deployed, harnesses);
  problems.push(...pinCollisions(v0.name, candidate, pins));

  const parsed = ProjectSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      json: candidate,
      pins,
      warnings,
      problems: [...problems, ...problemsFromZodError(SPEC_RELATIVE_PATH, candidate, parsed.error)],
      deployedChanges: [],
    };
  }

  const harmless: string[] = [];
  const deployedChanges: MigrationProblem[] = [];
  const undeployed: string[] = [];
  for (const path of droppedPaths(candidate, parsed.data)) {
    const described = describePath(candidate, path);
    if (isHarmlessDrop(path)) harmless.push(described);
    else if (isDeployedResource(candidate, path, deployed, everDeployed)) {
      deployedChanges.push({
        file: SPEC_RELATIVE_PATH,
        path: described,
        message: "v1 drops this field, which changes the deployed resource on the next deploy",
      });
    } else undeployed.push(described);
  }
  if (harmless.length > 0 || undeployed.length > 0) {
    warnings.push(`${DROPPED_FIELDS_WARNING}: ${[...harmless, ...undeployed].join(", ")}`);
  }
  return { json: parsed.data as unknown as Json, pins, warnings, problems, deployedChanges };
}

/**
 * Fields only the v0 CLI read, never sent to AWS: dropping them changes nothing
 * deployed. Every other dropped field is assumed to reach AWS.
 */
const HARMLESS_DROPS: RegExp[] = [
  // How the v0 CLI labelled an OAuth credential (inbound or outbound); not a provider property.
  /^credentials\.\d+\.usage$/,
];

function isHarmlessDrop(path: PropertyKey[]): boolean {
  const key = path.map(String).join(".");
  return HARMLESS_DROPS.some((pattern) => pattern.test(key));
}

/** The deployed-resource map for each top-level collection whose entries v0 records by name. */
const RECORDED_COLLECTIONS: Record<string, keyof DeployedResources> = {
  runtimes: "runtimes",
  memories: "memories",
  evaluators: "evaluators",
  onlineEvalConfigs: "onlineEvalConfigs",
  policyEngines: "policyEngines",
  configBundles: "configBundles",
  harnesses: "harnesses",
  agentCoreGateways: "gateways",
  credentials: "credentials",
  toolRuntimes: "mcpRuntimes",
};

/**
 * Whether the resource a dropped field belongs to is deployed. For collections v0
 * records by name that is exact; for anything else (payments, knowledge bases,
 * top-level fields) it is assumed to be deployed if the project ever was.
 */
function isDeployedResource(
  spec: Json,
  path: PropertyKey[],
  deployed: DeployedResources,
  everDeployed: boolean,
): boolean {
  const [collection, index] = path;
  const recorded = RECORDED_COLLECTIONS[String(collection)];
  if (!recorded || typeof index !== "number") return everDeployed;
  const entry = (spec[String(collection)] as Json[] | undefined)?.[index];
  return deployed[recorded].has(String(entry?.name));
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A recorded resource ID: the AWS name, a hyphen, and the service's 10-character suffix. */
function idOf(value: string, caseInsensitive = false): (id: string) => boolean {
  const pattern = new RegExp(
    `^${escapeRegExp(value)}-[A-Za-z0-9]{10}$`,
    caseInsensitive ? "i" : "",
  );
  return (id) => pattern.test(id);
}

/**
 * The v0 physical name of every deployed resource in `spec`, checked against what
 * each target recorded, with the targets that recorded it. These are the names
 * `migratedFrom: "v1"` makes the CDK library compose, and the plan checks the v1
 * synth against them. A recorded ID that doesn't match means v0 named the resource
 * some other way, which v0 naming wouldn't reproduce, so it is reported as a
 * problem. Credential provider names are kept by the credential provisioning
 * itself, not listed here.
 */
function pinDeployedNames(
  project: string,
  spec: Json,
  deployed: DeployedResources,
  harnesses: Record<string, HarnessFacts>,
): { pins: PinnedName[]; problems: MigrationProblem[] } {
  const pins: PinnedName[] = [];
  const problems: MigrationProblem[] = [];
  const list = (key: string) => (spec[key] as Json[] | undefined) ?? [];
  const problem = (resourceType: PinnedResourceType, name: string, message: string) =>
    problems.push({ file: SPEC_RELATIVE_PATH, path: `${resourceType} ${name}`, message });
  const set = (
    resourceType: PinnedResourceType,
    name: string,
    value: string,
    recorded: Recorded[],
  ) => {
    const targets = [...new Set(recorded.map((entry) => entry.target))];
    pins.push({ resourceType, name, value, targets });
  };

  /** Keeps `value` when every recorded entry matches it; `false` when it can't be kept. */
  const pin = (
    resourceType: PinnedResourceType,
    name: string,
    value: string,
    recorded: Recorded[] | undefined,
    matches: (recorded: string) => boolean = idOf(value),
  ): boolean => {
    if (!recorded) return false;
    const mismatched = recorded.filter((entry) => !matches(entry.id));
    if (mismatched.length > 0) {
      problem(
        resourceType,
        name,
        `deployed as '${mismatched.map((entry) => entry.id).join("', '")}', which doesn't match the name ` +
          `'${value}' v0 would have given it, so its name can't be kept safely`,
      );
      return false;
    }
    set(resourceType, name, value, recorded);
    return true;
  };

  for (const runtime of list("runtimes")) {
    const name = String(runtime.name);
    const recorded = deployed.runtimes.get(name);
    const pinned = pin("runtime", name, `${project}_${name}`, recorded);
    if (pinned && recorded && runtime.build === "Container") {
      set("runtime-repository", name, `${project}/${name}`.toLowerCase(), recorded);
    }
  }
  for (const memory of list("memories")) {
    const name = String(memory.name);
    pin("memory", name, `${project}_${name}`, deployed.memories.get(name));
  }
  for (const evaluator of list("evaluators")) {
    const name = String(evaluator.name);
    const recorded = deployed.evaluators.get(name);
    const pinned = pin("evaluator", name, `${project}_${name}`, recorded);
    const managed = (evaluator.config as { codeBased?: { managed?: Json } } | undefined)?.codeBased
      ?.managed;
    // Deployed state records no ID for the function, so it rides on the evaluator's own check.
    if (managed && pinned && recorded) {
      set("evaluator-function", name, `${project}-eval-${name}`, recorded);
    }
  }
  for (const config of list("onlineEvalConfigs")) {
    const name = String(config.name);
    pin("online-eval", name, `${project}_${name}`, deployed.onlineEvalConfigs.get(name));
  }
  for (const engine of list("policyEngines")) {
    const engineName = String(engine.name);
    pin(
      "policy-engine",
      engineName,
      `${project}_${engineName}`,
      deployed.policyEngines.get(engineName),
    );
    // Cedar policies are named verbatim in v0 and v1, so they keep their names unpinned.
  }
  for (const bundle of list("configBundles")) {
    const name = String(bundle.name);
    pin("config-bundle", name, `${project}${name}`, deployed.configBundles.get(name));
  }
  for (const harness of list("harnesses")) {
    const name = String(harness.name);
    const records = deployed.harnesses.get(name);
    if (!records) continue;
    // A record without the CloudFormation marker is a harness the v0 preview built
    // with API calls, outside any stack; CloudFormation can't adopt it.
    if (records.some((record) => record.provisioner !== "cloudformation")) {
      problem(
        "harness",
        name,
        `was created outside CloudFormation; remove it with 'npx @aws/agentcore@0 remove harness ${name} --keep' ` +
          "(or delete it) before migrating",
      );
      continue;
    }
    const pinned = pin("harness", name, `${project}_${name}`, records);
    const facts = harnesses[name];
    if (!pinned || !facts) continue;
    if (!facts.executionRoleArn) {
      const roleName = `${project}_${name}`;
      pin(
        "harness-role",
        name,
        roleName,
        records.map((record) => ({ target: record.target, id: record.roleArn })),
        (arn) => arn.endsWith(`/${roleName}`),
      );
    }
    // The libraries create the repository only under this condition (AgentCoreHarnessEnvironment).
    if (facts.hasDockerfile && facts.codeLocation && facts.dockerfile && !facts.containerUri) {
      set("harness-repository", name, `${project}/harness-${name}`.toLowerCase(), records);
    }
  }
  // v0 records gateway target Lambdas and runtimes, and tool runtimes, by their bare
  // name, so two of them with one name can't be told apart in the deployed state.
  const computeNames = new Map<string, string[]>();
  for (const gateway of list("agentCoreGateways")) {
    for (const target of (gateway.targets as Json[] | undefined) ?? []) {
      const host = (target.compute as Json | undefined)?.host;
      if (host !== "Lambda" && host !== "AgentCoreRuntime") continue;
      const owners = computeNames.get(String(target.name)) ?? [];
      owners.push(`gateway target '${String(gateway.name)}/${String(target.name)}'`);
      computeNames.set(String(target.name), owners);
    }
  }
  for (const tool of list("toolRuntimes")) {
    if (!(tool.compute as Json | undefined)?.runtime) continue;
    const owners = computeNames.get(String(tool.name)) ?? [];
    owners.push(`tool runtime '${String(tool.name)}'`);
    computeNames.set(String(tool.name), owners);
  }
  const clashes = new Set<string>();
  for (const [name, owners] of computeNames) {
    const recorded = deployed.mcpRuntimes.has(name) || deployed.mcpLambdas.has(name);
    if (owners.length < 2 || !recorded) continue;
    clashes.add(name);
    problems.push({
      file: SPEC_RELATIVE_PATH,
      path: owners.join(", "),
      message:
        `${owners.join(" and ")} share the name '${name}', under which v0 records their deployed ` +
        "compute, so migrate can't tell which deployed function or runtime belongs to which; " +
        "their names can't be kept safely",
    });
  }

  for (const gateway of list("agentCoreGateways")) {
    const name = String(gateway.name);
    // Gateway IDs are the lowercased name plus a suffix.
    if (typeof gateway.resourceName === "string") {
      // The spec's resourceName names the gateway (it wins over v0 naming in the
      // library), so the deployed ID must match it.
      const resourceName = gateway.resourceName;
      const matches = idOf(resourceName.toLowerCase(), true);
      const mismatched = (deployed.gateways.get(name) ?? []).filter((entry) => !matches(entry.id));
      if (mismatched.length > 0) {
        problem(
          "gateway",
          name,
          `deployed as '${mismatched.map((entry) => entry.id).join("', '")}', which doesn't match its ` +
            `resourceName '${resourceName}', so its name can't be kept safely`,
        );
      }
    } else {
      const value = `${project}-${name}`;
      pin("gateway", name, value, deployed.gateways.get(name), idOf(value.toLowerCase(), true));
    }
    for (const target of (gateway.targets as Json[] | undefined) ?? []) {
      const targetName = String(target.name);
      const key = `${name}/${targetName}`;
      const compute = target.compute as Json | undefined;
      if (clashes.has(targetName)) continue;
      if (compute?.host === "Lambda") {
        const recorded = deployed.mcpLambdas.get(targetName);
        const unique = [...new Set((recorded ?? []).map((entry) => entry.id))];
        if (unique.length > 1) {
          problem(
            "gateway-target-function",
            key,
            `deployed under different function names ('${unique.join("', '")}'), so one name can't be kept`,
          );
        } else if (recorded && unique[0] !== undefined) {
          // The recorded function name is the deployed name itself.
          set("gateway-target-function", key, unique[0], recorded);
        }
      }
      const runtime = compute?.runtime as Json | undefined;
      if (compute?.host === "AgentCoreRuntime" && runtime) {
        pin(
          "gateway-target-runtime",
          key,
          `${project}_${String(runtime.name)}`,
          deployed.mcpRuntimes.get(targetName),
        );
      }
    }
  }
  for (const tool of list("toolRuntimes")) {
    const name = String(tool.name);
    const runtime = (tool.compute as Json | undefined)?.runtime as Json | undefined;
    if (!runtime || clashes.has(name)) continue;
    pin("tool-runtime", name, `${project}_${String(runtime.name)}`, deployed.mcpRuntimes.get(name));
  }
  return { pins, problems };
}

/**
 * v1 validates deployment targets more strictly than v0 (no hyphens in names, no
 * names differing only by case). Target names are part of each target's stack
 * name, so they can't simply be renamed.
 */
export function convertTargets(raw: unknown): MigrationProblem[] {
  const parsed = AwsDeploymentTargetsSchema.safeParse(raw);
  if (parsed.success) return [];
  return problemsFromZodError(AWS_TARGETS_RELATIVE_PATH, raw, parsed.error).map((problem) =>
    /name/i.test(problem.path) || /target name/i.test(problem.message)
      ? {
          ...problem,
          message: `${problem.message}. Renaming a target deploys a new stack, so this project can't be migrated as is.`,
        }
      : problem,
  );
}
