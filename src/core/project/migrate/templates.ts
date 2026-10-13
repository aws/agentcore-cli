/**
 * The parts of a CloudFormation template migration planning reads, and the
 * intrinsic-function walking shared by the logical ID mapping, the bridge
 * template, and its digest check.
 */

export type CfnResource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  [key: string]: unknown;
};

export type CfnTemplate = {
  Resources?: Record<string, CfnResource>;
  Outputs?: Record<string, unknown>;
  Conditions?: Record<string, unknown>;
  [key: string]: unknown;
};

/** One reference from a resource to another resource in the same template. */
export type ResourceReference = {
  /** The referenced logical ID. */
  target: string;
  /**
   * Where in the referencing resource's properties the reference sits: property
   * keys joined with `.`, every array level written `[]`, intrinsic function
   * names left out. Stable across CDK versions that lay a property out the same
   * way, which is what lets references be paired between two templates.
   */
  path: string;
  /** The attribute read with Fn::GetAtt; absent for a Ref or a `${Id}` substitution. */
  attribute?: string;
};

/** The resources of a template, or none. */
export function resourcesOf(template: CfnTemplate): Record<string, CfnResource> {
  return template.Resources ?? {};
}

/** Custom resources run a provider on every create and delete, and CloudFormation can't move them. */
export function isCustomResource(type: string): boolean {
  return type.startsWith("Custom::") || type === "AWS::CloudFormation::CustomResource";
}

/** The resource every CDK stack carries for version reporting; never worth moving or reporting. */
export const CDK_METADATA_TYPE = "AWS::CDK::Metadata";

/** `${Name}` and `${Name.Attribute}` placeholders in an Fn::Sub string; `${!Literal}` is an escape. */
const SUB_PLACEHOLDER = /\$\{([^}!][^}]*)\}/g;

/**
 * Every reference in `value` to a resource for which `isResource` holds: Ref,
 * Fn::GetAtt in both its array and dotted-string forms, and Fn::Sub placeholders
 * (except the ones the Fn::Sub's own variable map defines). Refs to parameters
 * and pseudo parameters are not resources and are skipped.
 */
export function referencesIn(
  value: unknown,
  isResource: (logicalId: string) => boolean,
): ResourceReference[] {
  const found: ResourceReference[] = [];
  const visit = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) {
      const inArray = path.at(-1) === "[]" ? path : [...path, "[]"];
      for (const element of node) visit(element, inArray);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const at = path.join(".");

    const ref = record.Ref;
    if (typeof ref === "string" && Object.keys(record).length === 1) {
      if (isResource(ref)) found.push({ target: ref, path: at });
      return;
    }
    const getAtt = getAttParts(record["Fn::GetAtt"]);
    if (getAtt && Object.keys(record).length === 1) {
      if (isResource(getAtt.target)) {
        found.push({ target: getAtt.target, path: at, attribute: getAtt.attribute });
      }
      return;
    }
    const sub = subParts(record["Fn::Sub"]);
    if (sub && Object.keys(record).length === 1) {
      for (const placeholder of sub.template.matchAll(SUB_PLACEHOLDER)) {
        const [target = "", ...attribute] = placeholder[1]!.split(".");
        if (sub.variables.has(target) || !isResource(target)) continue;
        found.push({
          target,
          path: at,
          ...(attribute.length > 0 && { attribute: attribute.join(".") }),
        });
      }
      visit(sub.variableMap, path);
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      visit(child, key.startsWith("Fn::") ? path : [...path, key]);
    }
  };
  visit(value, []);
  return found;
}

/** The logical IDs a resource names in DependsOn. */
export function dependsOnOf(resource: CfnResource): string[] {
  const dependsOn = resource.DependsOn;
  if (typeof dependsOn === "string") return [dependsOn];
  return Array.isArray(dependsOn) ? dependsOn.filter((id) => typeof id === "string") : [];
}

/**
 * Returns `value` with every reference to a logical ID in `renames` rewritten to
 * the new ID: Ref, Fn::GetAtt (array and dotted-string forms), and Fn::Sub
 * placeholders that aren't the Fn::Sub's own variables. Nothing else changes, so
 * a literal that happens to equal a logical ID (such as the PolicyName CDK gives
 * a DefaultPolicy) is left as it is.
 */
export function renameReferences(value: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((element) => renameReferences(element, renames));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 1 && typeof record.Ref === "string") {
    return { Ref: renames.get(record.Ref) ?? record.Ref };
  }
  if (keys.length === 1 && "Fn::GetAtt" in record) {
    const getAtt = record["Fn::GetAtt"];
    if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
      return {
        "Fn::GetAtt": [
          renames.get(getAtt[0]) ?? getAtt[0],
          ...getAtt.slice(1).map((part) => renameReferences(part, renames)),
        ],
      };
    }
    if (typeof getAtt === "string") {
      const dot = getAtt.indexOf(".");
      const target = dot === -1 ? getAtt : getAtt.slice(0, dot);
      const renamed = renames.get(target);
      return { "Fn::GetAtt": renamed ? `${renamed}${getAtt.slice(target.length)}` : getAtt };
    }
  }
  if (keys.length === 1 && "Fn::Sub" in record) {
    const sub = subParts(record["Fn::Sub"]);
    if (sub) {
      const template = sub.template.replace(SUB_PLACEHOLDER, (whole, inner: string) => {
        const [target = "", ...rest] = inner.split(".");
        const renamed = sub.variables.has(target) ? undefined : renames.get(target);
        return renamed ? `\${${[renamed, ...rest].join(".")}}` : whole;
      });
      return {
        "Fn::Sub": Array.isArray(record["Fn::Sub"])
          ? [template, renameReferences(sub.variableMap, renames)]
          : template,
      };
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, renameReferences(child, renames)]),
  );
}

function getAttParts(value: unknown): { target: string; attribute: string } | undefined {
  if (Array.isArray(value) && typeof value[0] === "string") {
    return { target: value[0], attribute: typeof value[1] === "string" ? value[1] : "" };
  }
  if (typeof value === "string") {
    const dot = value.indexOf(".");
    return dot === -1
      ? { target: value, attribute: "" }
      : { target: value.slice(0, dot), attribute: value.slice(dot + 1) };
  }
  return undefined;
}

function subParts(
  value: unknown,
): { template: string; variables: Set<string>; variableMap: unknown } | undefined {
  if (typeof value === "string") return { template: value, variables: new Set(), variableMap: {} };
  if (Array.isArray(value) && typeof value[0] === "string") {
    const map = value[1];
    const variables =
      typeof map === "object" && map !== null && !Array.isArray(map) ? Object.keys(map) : [];
    return { template: value[0], variables: new Set(variables), variableMap: map ?? {} };
  }
  return undefined;
}

/** A canonical string for a JSON value: object keys sorted, so key order never matters. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * `value` with every reference for which `isTarget` holds rewritten by `replace`,
 * which receives the referenced ID and attribute (absent for a Ref) and returns
 * the value to put in place of a Ref or Fn::GetAtt, or the text to put in place
 * of an Fn::Sub placeholder.
 */
function mapReferences(
  value: unknown,
  isTarget: (logicalId: string) => boolean,
  replace: (target: string, attribute: string | undefined, inSub: boolean) => unknown,
): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (typeof node !== "object" || node === null) return node;
    const record = node as Record<string, unknown>;
    if (Object.keys(record).length === 1) {
      if (typeof record.Ref === "string") {
        return isTarget(record.Ref) ? replace(record.Ref, undefined, false) : record;
      }
      const getAtt = getAttParts(record["Fn::GetAtt"]);
      if (getAtt) {
        return isTarget(getAtt.target) ? replace(getAtt.target, getAtt.attribute, false) : record;
      }
      const sub = subParts(record["Fn::Sub"]);
      if (sub) {
        const template = sub.template.replace(SUB_PLACEHOLDER, (whole, inner: string) => {
          const [target = "", ...attribute] = inner.split(".");
          if (sub.variables.has(target) || !isTarget(target)) return whole;
          return String(
            replace(target, attribute.length > 0 ? attribute.join(".") : undefined, true),
          );
        });
        return {
          "Fn::Sub": Array.isArray(record["Fn::Sub"])
            ? [template, visit(sub.variableMap)]
            : template,
        };
      }
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, visit(child)]));
  };
  return visit(value);
}

/**
 * `value` with every reference to a resource (per `isResource`) replaced by a
 * placeholder that keeps the attribute read, so two values that differ only in
 * which logical IDs they point at compare equal. Refs to parameters and pseudo
 * parameters stay as they are.
 */
export function stripReferences(
  value: unknown,
  isResource: (logicalId: string) => boolean,
): unknown {
  return mapReferences(value, isResource, (_target, attribute, inSub) => {
    if (inSub) return attribute === undefined ? "${__ref__}" : `\${__ref__.${attribute}}`;
    return attribute === undefined ? { __ref__: "Ref" } : { __ref__: "Fn::GetAtt", attribute };
  });
}

/**
 * `value` with every reference to a resource in `isTarget` replaced by the
 * literal `marker`: how a resource reads once those resources resolve to some
 * physical ID.
 */
export function substituteReferences<T>(
  value: T,
  isTarget: (logicalId: string) => boolean,
  marker: string,
): T {
  return mapReferences(value, isTarget, () => marker) as T;
}
