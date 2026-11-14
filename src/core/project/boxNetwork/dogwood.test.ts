import { describe, expect, test } from "bun:test";
import { matchesLike, parsePolicy, type Expr, type Statement } from "./dogwood";

/** The shape of a condition, with each leaf as its source text. */
function shape(expr: Expr): unknown {
  switch (expr.kind) {
    case "or":
    case "and":
      return { [expr.kind]: expr.items.map(shape) };
    case "not":
      return { not: shape(expr.operand) };
    default:
      return expr.text;
  }
}

function only(source: string): Statement {
  const parsed = parsePolicy(source);
  expect(parsed.errors).toEqual([]);
  expect(parsed.statements).toHaveLength(1);
  return parsed.statements[0]!;
}

function cedar(statement: Statement, index = 0): Expr {
  const body = statement.conditions[index]!.body;
  if (body.kind !== "cedar") throw new Error(`condition ${index} is ${body.kind}`);
  return body.expr;
}

describe("parsePolicy reads", () => {
  test("annotations, the effect, and every scope form", () => {
    const s = only(
      '@id("gh") @description("GitHub") permit (principal == Box::Agent::"self", action in [Box::Action::"net:connect", Box::Action::"http:request"], resource is Box::Resource);',
    );
    expect(s).toMatchObject({
      id: "gh",
      annotations: { id: "gh", description: "GitHub" },
      effect: "permit",
      principal: { kind: "eq", entity: { type: ["Box", "Agent"], id: "self" } },
      action: {
        kind: "in",
        entities: [
          { type: ["Box", "Action"], id: "net:connect" },
          { type: ["Box", "Action"], id: "http:request" },
        ],
      },
      resource: { kind: "is", entityType: ["Box", "Resource"] },
      span: { line: 1, column: 1 },
    });
  });

  test("a positional id when a statement has no @id, as Cedar names it", () => {
    const parsed = parsePolicy(
      "permit (principal, action, resource);\nforbid (principal, action, resource);",
    );
    expect(parsed.statements.map((s) => [s.id, s.action.kind, s.span.line])).toEqual([
      ["policy0", "any", 1],
      ["policy1", "any", 2],
    ]);
  });

  test("&&, ||, !, and parentheses by Cedar's precedence", () => {
    const s = only(
      'forbid (principal, action, resource) when { context.input.host == "a" || !(context.input.port == 1) && context.input.method != "GET" };',
    );
    expect(shape(cedar(s))).toEqual({
      or: [
        'context.input.host == "a"',
        { and: [{ not: "(context.input.port == 1)" }, 'context.input.method != "GET"'] },
      ],
    });
  });

  test("like with an escaped star, has, is, sets, calls, and if-then-else", () => {
    const s = only(
      String.raw`permit (principal, action, resource) when { context.input.path like "/a\*b/*" && context.input has ip4 && principal is Box::Agent && ["GET", "POST"].contains(context.input.method) && ip(context.input.ip4).isInRange(ip("10.0.0.0/8")) && (if context.input.port == -1 then true else false) };`,
    );
    const expr = cedar(s);
    if (expr.kind !== "and") throw new Error("expected and");
    expect(expr.items.map((item) => item.kind)).toEqual([
      "like",
      "has",
      "is",
      "call",
      "call",
      "if",
    ]);
    const like = expr.items[0]!;
    if (like.kind !== "like") throw new Error("expected like");
    expect(like.pattern.parts).toEqual([{ kind: "literal", text: "/a*b/" }, { kind: "wildcard" }]);
    expect(matchesLike(like.pattern, "/a*b/c/d")).toBe(true);
    expect(matchesLike(like.pattern, "/axb/c")).toBe(false);
  });

  test("when and unless bodies, and comments anywhere", () => {
    const s = only(`// leading
@id("x") // after the annotation
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "a" } // a comment
unless { context.input.path == "/b" };`);
    expect(s.conditions.map((c) => [c.polarity, c.body.kind, c.span.line])).toEqual([
      ["when", "cedar", 4],
      ["unless", "cedar", 5],
    ]);
  });

  test("a temporal body as its text, without evaluating it", () => {
    const s = only(`forbid (principal, action == Box::Action::"http:request", resource)
when temporal {
  exists (n: Long). ((count for (t: Timepoint). where (formerly within 10m (
    // count the replies
    Box::Action::"http:request"::response{ input.host: "api.github.com" } && tp(t)))) == n && n >= 3)
};`);
    const body = s.conditions[0]!.body;
    expect(body.kind).toBe("temporal");
    if (body.kind !== "temporal") return;
    expect(body.text).not.toContain("count the replies");
    expect(body.text.startsWith("exists (n: Long).")).toBe(true);
  });

  test("a guardrails body as its text", () => {
    const s = only(
      "forbid (principal, action, resource) when guardrails { Box::Check(context.input.path) };",
    );
    expect(s.conditions[0]!.body).toEqual({
      kind: "guardrails",
      text: "Box::Check(context.input.path)",
    });
  });

  test("string escapes in literals and entity ids", () => {
    const s = only(
      String.raw`permit (principal, action, resource) when { context.input.path == "/a\"b\\c\u{41}" };`,
    );
    const expr = cedar(s);
    expect(expr.kind === "binary" && expr.right.kind === "literal" && expr.right.value).toBe(
      '/a"b\\cA',
    );
  });
});

describe("parsePolicy reports", () => {
  const errors = (source: string) => parsePolicy(source).errors;

  test("an unterminated string at its opening quote", () => {
    expect(
      errors('permit (principal, action, resource)\n  when { context.input.host == "a };'),
    ).toEqual([{ message: "unterminated string", span: { line: 2, column: 32 } }]);
  });

  test("an unexpected character", () => {
    expect(errors("permit (principal, action, resource) when { 1 # 2 };")).toEqual([
      { message: 'unexpected character "#"', span: { line: 1, column: 47 } },
    ]);
  });

  test("a missing semicolon at the token after the statement", () => {
    expect(
      errors("permit (principal, action, resource)\npermit (principal, action, resource);"),
    ).toEqual([{ message: "expected ;, found permit", span: { line: 2, column: 1 } }]);
  });

  test("an effect that is not permit or forbid", () => {
    expect(errors("allow (principal, action, resource);")).toEqual([
      { message: "expected permit or forbid, found allow", span: { line: 1, column: 1 } },
    ]);
  });

  test("an empty condition body", () => {
    expect(errors("permit (principal, action, resource) when { };")).toEqual([
      { message: "an empty when body", span: { line: 1, column: 45 } },
    ]);
  });

  test("an invalid escape", () => {
    expect(
      errors(String.raw`permit (principal, action, resource) when { context.input.path == "\q" };`),
    ).toEqual([{ message: "invalid escape \\q in a string", span: { line: 1, column: 67 } }]);
    expect(errors(String.raw`@id("\u{110000}") permit (principal, action, resource);`)).toEqual([
      { message: "invalid escape \\u in a string", span: { line: 1, column: 5 } },
    ]);
  });

  test("the end of the policy inside a statement", () => {
    expect(errors("permit (principal, action")).toEqual([
      { message: "unexpected end of the policy", span: { line: 1, column: 26 } },
    ]);
  });

  test("every bad statement, and still reads the good ones between them", () => {
    const parsed = parsePolicy(
      [
        "permit (principal, action, resource) when { context.input.host == };",
        '@id("ok") permit (principal, action, resource);',
        "forbid (principal, action resource);",
      ].join("\n"),
    );
    expect(parsed.statements.map((s) => s.id)).toEqual(["ok"]);
    expect(parsed.errors).toEqual([
      { message: "unexpected } in a condition", span: { line: 1, column: 67 } },
      { message: "expected ,, found resource", span: { line: 3, column: 27 } },
    ]);
  });
});
