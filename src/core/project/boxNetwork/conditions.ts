/**
 * Reduces a statement's scope and conditions, for one network action, to a disjunction of clauses.
 * Each clause is a conjunction of atoms: a test on a request field the gateway can route on (host,
 * port, method, path), a constant, or an opaque condition the gateway cannot read.
 */
import {
  matchesLike,
  type Condition,
  type EntityRef,
  type Expr,
  type LikePattern,
  type ScopeConstraint,
  type Statement,
} from "./dogwood";
import type { FailureCode } from "./types";

export type NetworkAction = "http:request" | "net:connect";

/** Every `Box::Action` id the box vocabulary holds. */
export const BOX_ACTIONS = new Set([
  "fs:read",
  "fs:write",
  "fs:delete",
  "fs:move",
  "fs:other",
  "net:connect",
  "http:request",
  "shell:exec",
  "shell:spawn",
  "mcp:call",
  "websocket:send",
  "websocket:receive",
]);

export type RequestField = "host" | "port" | "method" | "path" | "ip4" | "ip6";

export type Comparison =
  | { readonly op: "present" }
  | { readonly op: "==" | "!=" | "<" | "<=" | ">" | ">="; readonly value: string | number }
  | { readonly op: "like"; readonly pattern: LikePattern };

export interface FieldAtom {
  readonly kind: "field";
  readonly field: RequestField;
  readonly comparison: Comparison;
  readonly negated: boolean;
  readonly text: string;
}

/** A condition the converter cannot read: it holds in a permit, and does not in a forbid. */
export interface OpaqueAtom {
  readonly kind: "opaque";
  readonly text: string;
}

/** A condition with one value on every request the gateway carries. */
interface ConstantAtom {
  readonly kind: "constant";
  readonly value: boolean;
  /**
   * Why it is false: the gateway carries only TLS, the rule names another identity, or it reads
   * a WebSocket handshake, which build gives no target.
   */
  readonly cause: DeadCause;
  readonly text: string;
}

/** Why a clause can never hold on a request the gateway carries. */
export type DeadCause = "intercepted" | "identity" | "websocket";

type Atom = FieldAtom | OpaqueAtom | ConstantAtom;

export interface Clause {
  readonly fields: readonly FieldAtom[];
  readonly opaque: readonly OpaqueAtom[];
}

export type ClauseSet =
  | {
      readonly ok: true;
      readonly clauses: readonly Clause[];
      /** Why each clause that can never hold on the gateway was dropped. */
      readonly dead: readonly DeadCause[];
    }
  | { readonly ok: false; readonly code: FailureCode; readonly reason: string };

/** The most clauses a rule may expand to before it is refused. */
const MAX_CLAUSES = 256;

const INPUT_FIELDS: Record<NetworkAction, ReadonlySet<string>> = {
  "http:request": new Set([
    "host",
    "port",
    "method",
    "path",
    "body_bytes",
    "intercepted",
    "upgrade",
  ]),
  "net:connect": new Set(["host", "port", "ip4", "ip6"]),
};

const SELF: EntityRef = { type: ["Box", "Agent"], id: "self" };
const UNUSED_RESOURCE: EntityRef = { type: ["Box", "Resource"], id: "unused" };

class ClauseFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

type Formula =
  | { kind: "and" | "or"; items: Formula[] }
  | { kind: "not"; item: Formula }
  | { kind: "atom"; atom: Atom };

/** The statement's clauses for `action`, or why the statement cannot be read for it. */
export function clausesFor(statement: Statement, action: NetworkAction): ClauseSet {
  try {
    const parts: Formula[] = [
      scopeFormula(statement.principal, "principal", SELF),
      scopeFormula(statement.resource, "resource", UNUSED_RESOURCE),
    ];
    for (const condition of statement.conditions) {
      parts.push(conditionFormula(condition, action));
      // Box does not read a condition after one that an action test makes false.
      if (condition.body.kind !== "cedar") continue;
      if (actionValue(condition.body.expr, action) === (condition.polarity !== "when")) break;
    }
    const clauses: Clause[] = [];
    const dead: DeadCause[] = [];
    for (const atoms of disjunctiveNormalForm({ kind: "and", items: parts }, false)) {
      const falsified = atoms.find(
        (atom): atom is ConstantAtom => atom.kind === "constant" && !atom.value,
      );
      if (falsified) {
        dead.push(falsified.cause);
        continue;
      }
      clauses.push({
        fields: atoms.filter((atom): atom is FieldAtom => atom.kind === "field"),
        opaque: atoms.filter((atom): atom is OpaqueAtom => atom.kind === "opaque"),
      });
    }
    return { ok: true, clauses, dead };
  } catch (error) {
    if (!(error instanceof ClauseFailure)) throw error;
    return { ok: false, code: error.code, reason: error.message };
  }
}

/**
 * Whether `value` passes the atom. `null` is a field the request does not have: `has` is false
 * there, and any other test errs, so its rule does not apply.
 */
export function holds(atom: FieldAtom, value: string | number | null): boolean {
  if (atom.comparison.op === "present") return atom.negated !== (value !== null);
  return value !== null && atom.negated !== compare(atom.comparison, value);
}

function compare(
  comparison: Exclude<Comparison, { op: "present" }>,
  value: string | number,
): boolean {
  switch (comparison.op) {
    case "like":
      return typeof value === "string" && matchesLike(comparison.pattern, value);
    case "==":
      return value === comparison.value;
    case "!=":
      return value !== comparison.value;
    case "<":
      return value < comparison.value;
    case "<=":
      return value <= comparison.value;
    case ">":
      return value > comparison.value;
    case ">=":
      return value >= comparison.value;
  }
}

/** The value a positive `==` atom pins the field to, if the clause has one. */
export function pinnedValue(fields: readonly FieldAtom[], field: RequestField) {
  const atom = fields.find((a) => a.field === field && !a.negated && a.comparison.op === "==");
  return atom && atom.comparison.op === "==" ? atom.comparison.value : undefined;
}

function constant(value: boolean, text: string): Formula {
  return { kind: "atom", atom: { kind: "constant", value, cause: "identity", text } };
}

function opaque(text: string): Formula {
  return { kind: "atom", atom: { kind: "opaque", text } };
}

function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return a.id === b.id && a.type.join("::") === b.type.join("::");
}

/** Box's principal and resource are fixed, so a scope constraint on either is a constant. */
function scopeFormula(scope: ScopeConstraint, name: string, fixed: EntityRef): Formula {
  switch (scope.kind) {
    case "any":
      return constant(true, name);
    case "eq":
    case "in":
      return constant(sameEntity(scope.entity, fixed), `${name} ${scope.kind} …`);
    case "is":
      return constant(
        scope.entityType.join("::") === fixed.type.join("::") &&
          (scope.within === undefined || sameEntity(scope.within, fixed)),
        `${name} is ${scope.entityType.join("::")}`,
      );
  }
}

function conditionFormula(condition: Condition, action: NetworkAction): Formula {
  const body = condition.body;
  let formula: Formula;
  if (body.kind === "cedar") {
    checkAttributes(body.expr, action);
    formula = exprFormula(body.expr, action);
  } else if (body.kind === "guardrails") {
    formula = opaque(`guardrails { ${summary(body.text)} }`);
  } else {
    formula = opaque(`temporal { ${summary(body.text)} }`);
  }
  return condition.polarity === "when" ? formula : { kind: "not", item: formula };
}

/** A body's text on one line, cut short for a message. */
function summary(text: string): string {
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** `context.input.host` as `["context", "input", "host"]`, for any chain rooted at a variable. */
function attributePath(expr: Expr): string[] | undefined {
  if (expr.kind === "variable") return [expr.name];
  if (expr.kind === "attribute") {
    const base = attributePath(expr.object);
    return base && [...base, expr.name];
  }
  if (expr.kind === "index" && expr.key.kind === "literal" && typeof expr.key.value === "string") {
    const base = attributePath(expr.object);
    return base && [...base, expr.key.value];
  }
  return undefined;
}

/**
 * Refuses an attribute the action's context does not declare, as Box refuses it at load. As Box
 * reads a rule, an operand that an action test keeps from the action is not read: the right of
 * `||` after a test that holds, the right of `&&` after one that does not, and the other branch of
 * `if`.
 */
function checkAttributes(expr: Expr, action: NetworkAction): void {
  const path = attributePath(expr);
  if (path && path.length > 1) {
    checkPath(path, action, expr.text);
    return;
  }
  if (expr.kind === "and" || expr.kind === "or") {
    for (const item of expr.items) {
      checkAttributes(item, action);
      if (actionValue(item, action) === (expr.kind === "or")) return;
    }
    return;
  }
  if (expr.kind === "if") {
    checkAttributes(expr.test, action);
    const test = actionValue(expr.test, action);
    if (test !== false) checkAttributes(expr.then, action);
    if (test !== true) checkAttributes(expr.otherwise, action);
    return;
  }
  for (const child of children(expr)) checkAttributes(child, action);
}

/** The value of `expr` on `action` when only action tests and constants decide it. */
function actionValue(expr: Expr, action: NetworkAction): boolean | undefined {
  switch (expr.kind) {
    case "literal":
      return typeof expr.value === "boolean" ? expr.value : undefined;
    case "not": {
      const value = actionValue(expr.operand, action);
      return value === undefined ? undefined : !value;
    }
    case "and":
    case "or": {
      const values = expr.items.map((item) => actionValue(item, action));
      const decides = expr.kind === "or";
      if (values.includes(decides)) return decides;
      return values.every((value) => value === !decides) ? !decides : undefined;
    }
    case "binary": {
      if (expr.op !== "==" && expr.op !== "!=" && expr.op !== "in") return undefined;
      const variable = attributePath(expr.left);
      if (variable?.length !== 1 || variable[0] !== "action") return undefined;
      const entities = namedEntities(expr);
      if (!entities) return undefined;
      const matches = entities.some((e) => sameEntity(e, { type: ["Box", "Action"], id: action }));
      return expr.op === "!=" ? !matches : matches;
    }
    default:
      return undefined;
  }
}

function checkPath(path: string[], action: NetworkAction, text: string): void {
  const [root, group, field] = path;
  if (root === "principal" || root === "resource" || root === "action") {
    throw new ClauseFailure(
      "UNKNOWN_ATTRIBUTE",
      `reads ${text}, but the ${root} has no attributes in Box. Remove that condition.`,
    );
  }
  if (root !== "context" || group === undefined) return;
  const known =
    (group === "input" && (field === undefined || INPUT_FIELDS[action].has(field))) ||
    (group === "output" &&
      action === "http:request" &&
      (field === undefined || field === "status"));
  if (!known) {
    const fields = [...INPUT_FIELDS[action]].map((name) => `context.input.${name}`);
    if (action === "http:request") fields.push("context.output.status");
    throw new ClauseFailure(
      "UNKNOWN_ATTRIBUTE",
      `reads ${path.join(".")}, which ${action} does not have. Use one of ` +
        `${fields.slice(0, -1).join(", ")}, or ${fields.at(-1)}.`,
    );
  }
}

function children(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "or":
    case "and":
      return [...expr.items];
    case "not":
    case "negate":
      return [expr.operand];
    case "binary":
      return [expr.left, expr.right];
    case "like":
    case "has":
      return [expr.operand];
    case "is":
      return expr.within ? [expr.operand, expr.within] : [expr.operand];
    case "attribute":
      return [expr.object];
    case "index":
      return [expr.object, expr.key];
    case "call":
      return expr.receiver ? [expr.receiver, ...expr.args] : [...expr.args];
    case "set":
      return [...expr.items];
    case "record":
      return expr.entries.map((entry) => entry.value);
    case "if":
      return [expr.test, expr.then, expr.otherwise];
    case "variable":
    case "literal":
    case "entity":
      return [];
  }
}

function inputField(expr: Expr): string | undefined {
  const path = attributePath(expr);
  return path?.length === 3 && path[0] === "context" && path[1] === "input" ? path[2] : undefined;
}

const FLIPPED = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" } as const;

function exprFormula(expr: Expr, action: NetworkAction): Formula {
  switch (expr.kind) {
    case "and":
    case "or":
      return { kind: expr.kind, items: expr.items.map((item) => exprFormula(item, action)) };
    case "not":
      return { kind: "not", item: exprFormula(expr.operand, action) };
    case "literal":
      return typeof expr.value === "boolean" ? constant(expr.value, expr.text) : opaque(expr.text);
    default:
      return leafFormula(expr, action);
  }
}

function leafFormula(expr: Expr, action: NetworkAction): Formula {
  if (expr.kind === "has") return hasFormula(expr, action);
  if (expr.kind === "binary" && (expr.op === "==" || expr.op === "!=" || expr.op === "in")) {
    const identity = identityFormula(expr, action);
    if (identity) return identity;
  }
  if (expr.kind === "is") {
    const variable = attributePath(expr.operand);
    if (variable?.length === 1 && expr.within === undefined) {
      const fixed =
        variable[0] === "principal"
          ? SELF
          : variable[0] === "resource"
            ? UNUSED_RESOURCE
            : undefined;
      if (fixed) return constant(expr.entityType.join("::") === fixed.type.join("::"), expr.text);
    }
    return opaque(expr.text);
  }
  if (expr.kind === "like") {
    const field = inputField(expr.operand);
    if (isStringField(field)) {
      return fieldAtom(field, { op: "like", pattern: expr.pattern }, expr.text);
    }
    return opaque(expr.text);
  }
  if (expr.kind === "binary" && expr.op in FLIPPED) {
    const op = expr.op as keyof typeof FLIPPED;
    const leftField = inputField(expr.left);
    const rightField = inputField(expr.right);
    const [field, literal, flipped] =
      leftField !== undefined && expr.right.kind === "literal"
        ? [leftField, expr.right.value, op]
        : rightField !== undefined && expr.left.kind === "literal"
          ? [rightField, expr.left.value, FLIPPED[op]]
          : [undefined, undefined, op];
    if (field === "intercepted" && typeof literal === "boolean" && (op === "==" || op === "!=")) {
      // Every request the gateway carries arrives over TLS, which Box reports as intercepted.
      const value = op === "==" ? literal : !literal;
      return {
        kind: "atom",
        atom: { kind: "constant", value, cause: "intercepted", text: expr.text },
      };
    }
    if (field === "upgrade" && typeof literal === "string" && (op === "==" || op === "!=")) {
      // Box sets upgrade to "websocket" on a WebSocket handshake, and build gives a WebSocket no
      // target, so every request the gateway carries has upgrade "".
      const value = op === "==" ? literal === "" : literal !== "";
      return {
        kind: "atom",
        atom: { kind: "constant", value, cause: "websocket", text: expr.text },
      };
    }
    if (field === "body_bytes") return opaque(expr.text);
    if (
      isStringField(field) &&
      typeof literal === "string" &&
      (flipped === "==" || flipped === "!=")
    ) {
      return fieldAtom(field, { op: flipped, value: literal }, expr.text);
    }
    if (field === "port" && typeof literal === "number") {
      return fieldAtom("port", { op: flipped, value: literal }, expr.text);
    }
    return opaque(expr.text);
  }
  if (expr.kind === "call" && expr.name === "contains" && expr.receiver?.kind === "set") {
    const field = expr.args.length === 1 ? inputField(expr.args[0]!) : undefined;
    const values = expr.receiver.items.map((item) =>
      item.kind === "literal" ? item.value : undefined,
    );
    if (isStringField(field) && values.every((value) => typeof value === "string")) {
      return {
        kind: "or",
        items: values.map((value) =>
          fieldAtom(field, { op: "==", value: value as string }, expr.text),
        ),
      };
    }
  }
  return opaque(expr.text);
}

/** A `has` test on the context, which Box's closed context records make a constant. */
function hasFormula(expr: Extract<Expr, { kind: "has" }>, action: NetworkAction): Formula {
  const target = attributePath(expr.operand)?.join(".");
  const path =
    target === "context"
      ? expr.attribute
      : target === "context.input"
        ? ["input", ...expr.attribute]
        : undefined;
  if (path === undefined) return opaque(expr.text);
  const [group, field, ...rest] = path;
  if (group === "output") return opaque(expr.text);
  if (group !== "input" || rest.length > 0) return constant(false, expr.text);
  if (field === undefined) return constant(true, expr.text);
  if (field === "ip4" || field === "ip6") {
    return action === "net:connect"
      ? fieldAtom(field, { op: "present" }, expr.text)
      : constant(false, expr.text);
  }
  return constant(INPUT_FIELDS[action].has(field), expr.text);
}

/** `principal == …`, `resource == …`, and `action == …` against Box's fixed values. */
function identityFormula(
  expr: Extract<Expr, { kind: "binary" }>,
  action: NetworkAction,
): Formula | undefined {
  const variable = attributePath(expr.left);
  if (variable?.length !== 1) return undefined;
  const entities = namedEntities(expr);
  if (!entities) return undefined;
  let matches: boolean;
  if (variable[0] === "action") {
    for (const entity of entities) checkAction(entity);
    matches = entities.some((e) => sameEntity(e, { type: ["Box", "Action"], id: action }));
  } else if (variable[0] === "principal" || variable[0] === "resource") {
    const fixed = variable[0] === "principal" ? SELF : UNUSED_RESOURCE;
    matches = entities.some((e) => sameEntity(e, fixed));
  } else {
    return undefined;
  }
  return constant(expr.op === "!=" ? !matches : matches, expr.text);
}

/** The entities the right of `==`, `!=`, or `in` names: one entity, or a set of entities. */
function namedEntities(expr: Extract<Expr, { kind: "binary" }>): EntityRef[] | undefined {
  const right = expr.right;
  if (right.kind === "entity") return [right.entity];
  if (expr.op !== "in" || right.kind !== "set" || !right.items.every(isEntity)) return undefined;
  return right.items.map((item) => item.entity);
}

function isEntity(expr: Expr): expr is Extract<Expr, { kind: "entity" }> {
  return expr.kind === "entity";
}

/** Why a rule that names the `Box::Action` `id`, which Box does not have, fails. */
export function unknownActionReason(id: string): string {
  return (
    `names the action Box::Action::"${id}", which Box does not have. Use a Box action, such as ` +
    'Box::Action::"http:request" or Box::Action::"net:connect".'
  );
}

/** Whether `entity` is a `Box::Action` the vocabulary does not hold. */
export function isUnknownBoxAction(entity: EntityRef): boolean {
  return entity.type.join("::") === "Box::Action" && !BOX_ACTIONS.has(entity.id);
}

function checkAction(entity: EntityRef): void {
  if (isUnknownBoxAction(entity)) {
    throw new ClauseFailure("UNKNOWN_ACTION", unknownActionReason(entity.id));
  }
}

/** The fields a rule compares with a string. */
function isStringField(field: string | undefined): field is Exclude<RequestField, "port"> {
  return (
    field === "host" || field === "method" || field === "path" || field === "ip4" || field === "ip6"
  );
}

function fieldAtom(field: RequestField, comparison: Comparison, text: string): Formula {
  if (field === "host") checkHostLiteral(comparison, text);
  return {
    kind: "atom",
    atom: { kind: "field", field, comparison, negated: false, text },
  };
}

/** Refuses a host Box never presents: Box compares hosts in lower case with no trailing dot. */
function checkHostLiteral(comparison: Comparison, text: string): void {
  const literal =
    comparison.op === "like"
      ? comparison.pattern.parts.map((p) => (p.kind === "literal" ? p.text : "*")).join("")
      : comparison.op === "present"
        ? ""
        : String(comparison.value);
  if (literal !== literal.toLowerCase() || literal.endsWith(".")) {
    throw new ClauseFailure(
      "INVALID_HOST",
      `compares the host with ${JSON.stringify(literal)} (${text}), which never matches, ` +
        "because Box compares hosts in lower case with no trailing dot. Write the host as " +
        `${JSON.stringify(literal.toLowerCase().replace(/\.+$/, ""))}.`,
    );
  }
}

function negate(atom: Atom): Atom {
  switch (atom.kind) {
    case "field":
      return { ...atom, negated: !atom.negated };
    case "constant":
      return { ...atom, value: !atom.value };
    case "opaque":
      return atom;
  }
}

/** Pushes negation down to the atoms and returns the disjunction of conjunctions. */
function disjunctiveNormalForm(formula: Formula, negated: boolean): Atom[][] {
  if (formula.kind === "atom") return [[negated ? negate(formula.atom) : formula.atom]];
  if (formula.kind === "not") return disjunctiveNormalForm(formula.item, !negated);
  const isOr = (formula.kind === "or") !== negated;
  if (isOr) {
    const clauses = formula.items.flatMap((item) => disjunctiveNormalForm(item, negated));
    if (clauses.length > MAX_CLAUSES) throw tooComplex();
    return clauses;
  }
  let product: Atom[][] = [[]];
  for (const item of formula.items) {
    const parts = disjunctiveNormalForm(item, negated);
    product = product.flatMap((left) => parts.map((right) => [...left, ...right]));
    if (product.length > MAX_CLAUSES) throw tooComplex();
  }
  return product;
}

function tooComplex(): ClauseFailure {
  return new ClauseFailure(
    "CONDITION_TOO_COMPLEX",
    `has a condition with more than ${MAX_CLAUSES} cases, which is too many for build to check. ` +
      "Split it into smaller rules.",
  );
}
