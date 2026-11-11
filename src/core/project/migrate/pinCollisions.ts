import { SPEC_RELATIVE_PATH } from "./convertSpec";
import type {
  MigrationProblem,
  PinnedName,
  PinnedResourceType,
} from "../../../handlers/project/migrate/types";
import { describePath } from "./issues";

type Json = Record<string, unknown>;

/**
 * A migrated project keeps v0's physical names, which have no target segment, so
 * two resources (or two targets in one account and region) can claim the same
 * name. Finding that in the plan beats a deploy failing on a name conflict.
 */
/** One resource that takes an AWS physical name: its deployed name, or the one v0 naming composes. */
type NameEntry = {
  label: string;
  path: (string | number)[];
  /** The deployed name the resource keeps, when it is deployed. */
  pinned?: string;
  /** The segment the v0 name ends with: `<project><separator><suffix>`. */
  suffix: string;
  separator: "_" | "-" | "/";
  /** The service lowercases the name (ECR repositories). */
  lowercase?: boolean;
};

const list = (spec: Json, key: string) => (spec[key] as Json[] | undefined) ?? [];

/** The pinned AWS name of a resource, by its pin's resource type and name. */
type PinnedOf = (resourceType: PinnedResourceType, name: string) => string | undefined;

/**
 * Groups every named resource by the AWS namespace its name lives in, so two
 * resources that would claim one AWS name are caught here. The `@aws/agentcore-cdk`
 * library doesn't check physical names for uniqueness, so this is the only check
 * before the deploy would fail.
 */
function nameGroups(spec: Json, pinnedOf: PinnedOf): Map<string, NameEntry[]> {
  const named = (
    kind: string,
    resourceType: PinnedResourceType,
    collection: string,
    separator: "_" | "-",
  ) =>
    list(spec, collection).map((item, i) => ({
      label: `${kind} "${String(item.name)}"`,
      path: [collection, i],
      pinned: pinnedOf(resourceType, String(item.name)),
      suffix: String(item.name),
      separator,
    }));

  const runtimes: NameEntry[] = named("runtime", "runtime", "runtimes", "_");
  for (const [i, tool] of list(spec, "toolRuntimes").entries()) {
    const runtime = (tool.compute as Json | undefined)?.runtime as Json | undefined;
    if (!runtime) continue;
    runtimes.push({
      label: `tool runtime "${String(tool.name)}"`,
      path: ["toolRuntimes", i],
      pinned: pinnedOf("tool-runtime", String(tool.name)),
      suffix: String(runtime.name),
      separator: "_",
    });
  }
  const lambdas: NameEntry[] = [];
  for (const [i, evaluator] of list(spec, "evaluators").entries()) {
    const managed = (evaluator.config as { codeBased?: { managed?: Json } } | undefined)?.codeBased
      ?.managed;
    if (!managed) continue;
    lambdas.push({
      label: `evaluator "${String(evaluator.name)}" Lambda function`,
      path: ["evaluators", i],
      pinned: pinnedOf("evaluator-function", String(evaluator.name)),
      suffix: `eval-${String(evaluator.name)}`,
      separator: "-",
    });
  }
  for (const [g, gateway] of list(spec, "agentCoreGateways").entries()) {
    for (const [t, target] of ((gateway.targets as Json[] | undefined) ?? []).entries()) {
      const compute = target.compute as Json | undefined;
      const runtime = compute?.runtime as Json | undefined;
      if (compute?.host === "Lambda") {
        lambdas.push({
          label: `gateway target "${String(target.name)}" Lambda function`,
          path: ["agentCoreGateways", g, "targets", t],
          pinned: pinnedOf(
            "gateway-target-function",
            `${String(gateway.name)}/${String(target.name)}`,
          ),
          suffix: String(target.name),
          separator: "-",
        });
      } else if (runtime) {
        runtimes.push({
          label: `gateway target "${String(target.name)}" runtime`,
          path: ["agentCoreGateways", g, "targets", t],
          pinned: pinnedOf(
            "gateway-target-runtime",
            `${String(gateway.name)}/${String(target.name)}`,
          ),
          suffix: String(runtime.name),
          separator: "_",
        });
      }
    }
  }
  const repositories: NameEntry[] = [
    ...list(spec, "runtimes").flatMap((runtime, i) =>
      runtime.build === "Container"
        ? [
            {
              label: `runtime "${String(runtime.name)}" ECR repository`,
              path: ["runtimes", i],
              pinned: pinnedOf("runtime-repository", String(runtime.name)),
              suffix: String(runtime.name),
              separator: "/" as const,
              lowercase: true,
            },
          ]
        : [],
    ),
    ...list(spec, "harnesses").map((harness, i) => ({
      label: `harness "${String(harness.name)}" ECR repository`,
      path: ["harnesses", i],
      pinned: pinnedOf("harness-repository", String(harness.name)),
      suffix: `harness-${String(harness.name)}`,
      separator: "/" as const,
      lowercase: true,
    })),
  ];
  const roles: NameEntry[] = list(spec, "harnesses").map((harness, i) => ({
    label: `harness "${String(harness.name)}" execution role`,
    path: ["harnesses", i],
    pinned: pinnedOf("harness-role", String(harness.name)),
    suffix: String(harness.name),
    separator: "_" as const,
  }));

  return new Map([
    ["runtime", runtimes],
    ["memory", named("memory", "memory", "memories", "_")],
    ["evaluator", named("evaluator", "evaluator", "evaluators", "_")],
    ["online eval config", named("online eval config", "online-eval", "onlineEvalConfigs", "_")],
    ["policy engine", named("policy engine", "policy-engine", "policyEngines", "_")],
    ["gateway", named("gateway", "gateway", "agentCoreGateways", "-")],
    ["harness", named("harness", "harness", "harnesses", "_")],
    ["Lambda function", lambdas],
    ["ECR repository", repositories],
    ["IAM role", roles],
  ]);
}

/** The AWS name a resource gets in a migrated project: its deployed name, or v0's composed one. */
function v0Name(project: string, entry: NameEntry): string {
  if (entry.pinned !== undefined) return entry.pinned;
  const name = `${project}${entry.separator}${entry.suffix}`;
  return entry.lowercase ? name.toLowerCase() : name;
}

/**
 * Resources that would claim one AWS name in the migrated project. A project
 * migrated from v0 (`migratedFrom: "v1"`) names every resource the v0 way,
 * `<project><separator><name>` with no target segment, including resources added
 * after the migration, so two resources whose names line up (a runtime and a tool
 * runtime with one runtime name, say) collide on every deploy.
 */
export function pinCollisions(project: string, spec: Json, pins: PinnedName[]): MigrationProblem[] {
  const byResource = new Map(pins.map((pin) => [`${pin.resourceType} ${pin.name}`, pin.value]));
  const pinnedOf: PinnedOf = (resourceType, name) => byResource.get(`${resourceType} ${name}`);
  const problems: MigrationProblem[] = [];
  for (const [kind, entries] of nameGroups(spec, pinnedOf)) {
    const claimedBy = new Map<string, NameEntry>();
    for (const entry of entries) {
      const name = v0Name(project, entry);
      const other = claimedBy.get(name);
      if (other) {
        problems.push({
          file: SPEC_RELATIVE_PATH,
          path: describePath(spec, entry.path),
          message:
            `${entry.label} and ${other.label} both get the ${kind} name '${name}' (a migrated ` +
            `project keeps v0's names, which have no target segment); rename one of them before migrating`,
        });
      } else {
        claimedBy.set(name, entry);
      }
    }
  }
  return problems;
}
