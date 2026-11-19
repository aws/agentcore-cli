/**
 * A reader for the Dogwood a compiled Box `policy.dw` holds: Cedar statements with annotations,
 * scopes, and `when`/`unless` conditions, plus Dogwood's `when temporal { … }` and
 * `when guardrails { … }` bodies, which the reader keeps as their text.
 */

/** A 1-based position in the policy source. */
export interface SourceSpan {
  readonly line: number;
  readonly column: number;
}

/** A syntax error, at the token that broke the statement. */
export interface DogwoodSyntaxError {
  readonly message: string;
  readonly span: SourceSpan;
}

/** `Box::Action::"http:request"`: a type path and an id. */
export interface EntityRef {
  readonly type: readonly string[];
  readonly id: string;
}

/** A `like` pattern: literal runs and `*` wildcards. `\*` in the source is a literal star. */
export interface LikePattern {
  readonly parts: readonly ({ kind: "literal"; text: string } | { kind: "wildcard" })[];
}

export type Expr = (
  | { kind: "or" | "and"; items: readonly Expr[] }
  | { kind: "not" | "negate"; operand: Expr }
  | {
      kind: "binary";
      op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "+" | "-" | "*";
      left: Expr;
      right: Expr;
    }
  | { kind: "like"; operand: Expr; pattern: LikePattern }
  | { kind: "has"; operand: Expr; attribute: readonly string[] }
  | { kind: "is"; operand: Expr; entityType: readonly string[]; within?: Expr }
  | { kind: "variable"; name: "principal" | "action" | "resource" | "context" }
  | { kind: "attribute"; object: Expr; name: string }
  | { kind: "index"; object: Expr; key: Expr }
  | { kind: "call"; name: string; receiver?: Expr; args: readonly Expr[] }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "entity"; entity: EntityRef }
  | { kind: "set"; items: readonly Expr[] }
  | { kind: "record"; entries: readonly { key: string; value: Expr }[] }
  | { kind: "if"; test: Expr; then: Expr; otherwise: Expr }
) & { readonly text: string };

/** A principal or resource scope constraint. */
export type ScopeConstraint =
  | { kind: "any" }
  | { kind: "eq" | "in"; entity: EntityRef }
  | { kind: "is"; entityType: readonly string[]; within?: EntityRef };

export type ActionScope =
  | { kind: "any" }
  | { kind: "eq"; entity: EntityRef }
  | { kind: "in"; entities: readonly EntityRef[] };

export type ConditionBody =
  | { kind: "cedar"; expr: Expr }
  | { kind: "temporal"; text: string }
  | { kind: "guardrails"; text: string };

export interface Condition {
  readonly polarity: "when" | "unless";
  readonly body: ConditionBody;
  readonly span: SourceSpan;
}

export interface Statement {
  /** The `@id` annotation, or Cedar's positional `policy<N>` when there is none. */
  readonly id: string;
  readonly annotations: Readonly<Record<string, string>>;
  readonly effect: "permit" | "forbid";
  readonly principal: ScopeConstraint;
  readonly action: ActionScope;
  readonly resource: ScopeConstraint;
  readonly conditions: readonly Condition[];
  readonly span: SourceSpan;
  readonly text: string;
}

export interface ParsedPolicy {
  readonly statements: readonly Statement[];
  readonly errors: readonly DogwoodSyntaxError[];
}

/** Parses every statement. A statement with a syntax error is skipped, and the next one is read. */
export function parsePolicy(source: string): ParsedPolicy {
  const lexed = tokenize(source);
  if ("error" in lexed) return { statements: [], errors: [lexed.error] };
  const parser = new Parser(source, lexed.tokens);
  const statements: Statement[] = [];
  const errors: DogwoodSyntaxError[] = [];
  while (!parser.atEnd()) {
    try {
      statements.push(parser.statement(statements.length + errors.length));
    } catch (error) {
      if (!(error instanceof SyntaxFailure)) throw error;
      errors.push({ message: error.message, span: error.span });
      parser.recover();
    }
  }
  return { statements, errors };
}

const likeExpressions = new WeakMap<LikePattern, RegExp>();

/** Whether `text` matches `pattern` under Cedar's `like`, where `*` matches any run of characters. */
export function matchesLike(pattern: LikePattern, text: string): boolean {
  let expression = likeExpressions.get(pattern);
  if (!expression) {
    const source = pattern.parts
      .map((part) => (part.kind === "wildcard" ? "[\\s\\S]*" : escapeRegExp(part.text)))
      .join("");
    expression = new RegExp(`^${source}$`);
    likeExpressions.set(pattern, expression);
  }
  return expression.test(text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind = "ident" | "string" | "number" | "punct";

interface Token {
  readonly kind: TokenKind;
  /** An identifier, a punctuator, a number's digits, or a string's raw text between the quotes. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly span: SourceSpan;
}

const PUNCTUATORS = [
  "::",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ";",
  ".",
  "@",
  "<",
  ">",
  "!",
  ":",
  "+",
  "-",
  "*",
] as const;

class SyntaxFailure extends Error {
  constructor(
    message: string,
    readonly span: SourceSpan,
  ) {
    super(message);
  }
}

function tokenize(source: string): { tokens: Token[] } | { error: DogwoodSyntaxError } {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const spanAt = (offset: number): SourceSpan => ({ line, column: offset - lineStart + 1 });
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    const start = i;
    const span = spanAt(start);
    if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\n") break;
        i += source[i] === "\\" ? 2 : 1;
      }
      if (source[i] !== '"') return { error: { message: "unterminated string", span } };
      tokens.push({ kind: "string", value: source.slice(start + 1, i), start, end: i + 1, span });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      tokens.push({ kind: "number", value: source.slice(start, i), start, end: i, span });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i), start, end: i, span });
      continue;
    }
    const punct = PUNCTUATORS.find((p) => source.startsWith(p, i));
    if (!punct) return { error: { message: `unexpected character ${JSON.stringify(c)}`, span } };
    tokens.push({ kind: "punct", value: punct, start, end: i + punct.length, span });
    i += punct.length;
  }
  return { tokens };
}

/** Decodes a string token's raw text. A `like` pattern keeps `\*` apart, so it is decoded there. */
function decodeString(raw: string, span: SourceSpan): string {
  return decodeChars(raw, span)
    .map((c) => c.char)
    .join("");
}

function decodeChars(raw: string, span: SourceSpan): { char: string; escaped: boolean }[] {
  const out: { char: string; escaped: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") {
      out.push({ char: c, escaped: false });
      continue;
    }
    const next = raw[++i];
    const simple: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      "0": "\0",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "*": "*",
    };
    if (next !== undefined && next in simple) {
      out.push({ char: simple[next]!, escaped: true });
      continue;
    }
    const unicode = next === "u" ? /^\{([0-9A-Fa-f]{1,6})\}/.exec(raw.slice(i + 1)) : null;
    const codePoint = unicode ? parseInt(unicode[1]!, 16) : NaN;
    if (unicode && codePoint <= 0x10ffff) {
      out.push({ char: String.fromCodePoint(codePoint), escaped: true });
      i += unicode[0].length;
      continue;
    }
    throw new SyntaxFailure(`invalid escape \\${next ?? ""} in a string`, span);
  }
  return out;
}

function decodePattern(raw: string, span: SourceSpan): LikePattern {
  const parts: ({ kind: "literal"; text: string } | { kind: "wildcard" })[] = [];
  for (const { char, escaped } of decodeChars(raw, span)) {
    if (char === "*" && !escaped) {
      if (parts.at(-1)?.kind !== "wildcard") parts.push({ kind: "wildcard" });
      continue;
    }
    const last = parts.at(-1);
    if (last?.kind === "literal") last.text += char;
    else parts.push({ kind: "literal", text: char });
  }
  return { parts };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

const VARIABLES = new Set(["principal", "action", "resource", "context"]);
const RELATION_OPERATORS = new Set(["==", "!=", "<", "<=", ">", ">="]);

class Parser {
  private i = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: readonly Token[],
  ) {}

  atEnd(): boolean {
    return this.i >= this.tokens.length;
  }

  /** Skips past the next `;` outside brackets, so one bad statement costs only itself. */
  recover(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const t = this.tokens[this.i++]!;
      if (t.kind !== "punct") continue;
      if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
      else if (t.value === ")" || t.value === "]" || t.value === "}")
        depth = Math.max(0, depth - 1);
      else if (t.value === ";" && depth === 0) return;
    }
  }

  statement(index: number): Statement {
    const first = this.peek();
    const annotations: Record<string, string> = {};
    while (this.isPunct("@")) {
      this.i++;
      const name = this.expect("ident", "an annotation name");
      if (name.value in annotations) this.fail(`duplicate annotation @${name.value}`, name);
      let value = "";
      if (this.isPunct("(")) {
        this.i++;
        const text = this.expect("string", "an annotation value");
        value = decodeString(text.value, text.span);
        this.expectPunct(")");
      }
      annotations[name.value] = value;
    }
    const effect = this.expect("ident", "permit or forbid");
    if (effect.value !== "permit" && effect.value !== "forbid") {
      this.fail(`expected permit or forbid, found ${effect.value}`, effect);
    }
    this.expectPunct("(");
    const principal = this.scopeConstraint("principal");
    this.expectPunct(",");
    const action = this.actionScope();
    this.expectPunct(",");
    const resource = this.scopeConstraint("resource");
    if (this.isPunct(",")) this.i++;
    this.expectPunct(")");
    const conditions: Condition[] = [];
    while (this.isIdent("when") || this.isIdent("unless")) {
      conditions.push(this.condition());
    }
    const end = this.expectPunct(";");
    return {
      id: annotations.id ?? `policy${index}`,
      annotations,
      effect: effect.value as "permit" | "forbid",
      principal,
      action,
      resource,
      conditions,
      span: first.span,
      text: this.source.slice(first.start, end.end),
    };
  }

  private scopeConstraint(variable: "principal" | "resource"): ScopeConstraint {
    const head = this.expect("ident", variable);
    if (head.value !== variable) this.fail(`expected ${variable}, found ${head.value}`, head);
    if (this.isPunct("==")) {
      this.i++;
      return { kind: "eq", entity: this.entity() };
    }
    if (this.isIdent("in")) {
      this.i++;
      return { kind: "in", entity: this.entity() };
    }
    if (this.isIdent("is")) {
      this.i++;
      const entityType = this.typePath();
      if (!this.isIdent("in")) return { kind: "is", entityType };
      this.i++;
      return { kind: "is", entityType, within: this.entity() };
    }
    return { kind: "any" };
  }

  private actionScope(): ActionScope {
    const head = this.expect("ident", "action");
    if (head.value !== "action") this.fail(`expected action, found ${head.value}`, head);
    if (this.isPunct("==")) {
      this.i++;
      return { kind: "eq", entity: this.entity() };
    }
    if (!this.isIdent("in")) return { kind: "any" };
    this.i++;
    if (!this.isPunct("[")) return { kind: "in", entities: [this.entity()] };
    this.i++;
    const entities: EntityRef[] = [];
    while (!this.isPunct("]")) {
      entities.push(this.entity());
      if (!this.isPunct(",")) break;
      this.i++;
    }
    this.expectPunct("]");
    return { kind: "in", entities };
  }

  private condition(): Condition {
    const keyword = this.tokens[this.i++]!;
    const polarity = keyword.value as "when" | "unless";
    let kind: "cedar" | "temporal" | "guardrails" = "cedar";
    if (this.isIdent("temporal") || this.isIdent("guardrails")) {
      kind = this.tokens[this.i++]!.value as "temporal" | "guardrails";
    }
    this.expectPunct("{");
    if (kind === "cedar") {
      if (this.isPunct("}")) this.fail(`an empty ${polarity} body`, this.peek());
      const expr = this.expr();
      this.expectPunct("}");
      return { polarity, body: { kind, expr }, span: keyword.span };
    }
    const bodyStart = this.i;
    let depth = 0;
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.kind === "punct" && t.value === "{") depth++;
      if (t.kind === "punct" && t.value === "}") {
        if (depth === 0) break;
        depth--;
      }
      this.i++;
    }
    const close = this.expectPunct("}");
    const body = this.tokens.slice(bodyStart, this.i - 1);
    if (body.length === 0) this.fail(`an empty ${kind} body`, close);
    const text = this.textOf(body);
    return { polarity, body: { kind, text }, span: keyword.span };
  }

  // -------------------------------------------------------------------------
  // Expressions, by Cedar's precedence
  // -------------------------------------------------------------------------

  private expr(): Expr {
    if (!this.isIdent("if")) return this.or();
    const start = this.tokens[this.i++]!;
    const test = this.expr();
    this.expectIdent("then");
    const then = this.expr();
    this.expectIdent("else");
    const otherwise = this.expr();
    return { kind: "if", test, then, otherwise, text: this.textFrom(start) };
  }

  private or(): Expr {
    const start = this.peek();
    const items = [this.and()];
    while (this.isPunct("||")) {
      this.i++;
      items.push(this.and());
    }
    return items.length === 1 ? items[0]! : { kind: "or", items, text: this.textFrom(start) };
  }

  private and(): Expr {
    const start = this.peek();
    const items = [this.relation()];
    while (this.isPunct("&&")) {
      this.i++;
      items.push(this.relation());
    }
    return items.length === 1 ? items[0]! : { kind: "and", items, text: this.textFrom(start) };
  }

  private relation(): Expr {
    const start = this.peek();
    const left = this.additive();
    const t = this.tokens[this.i];
    if (t?.kind === "punct" && RELATION_OPERATORS.has(t.value)) {
      this.i++;
      const right = this.additive();
      const op = t.value as "==" | "!=" | "<" | "<=" | ">" | ">=";
      return { kind: "binary", op, left, right, text: this.textFrom(start) };
    }
    if (this.isIdent("in")) {
      this.i++;
      const right = this.additive();
      return { kind: "binary", op: "in", left, right, text: this.textFrom(start) };
    }
    if (this.isIdent("like")) {
      this.i++;
      const pattern = this.expect("string", "a like pattern");
      return {
        kind: "like",
        operand: left,
        pattern: decodePattern(pattern.value, pattern.span),
        text: this.textFrom(start),
      };
    }
    if (this.isIdent("has")) {
      this.i++;
      const attribute = [this.attributeName()];
      while (this.isPunct(".")) {
        this.i++;
        attribute.push(this.attributeName());
      }
      return { kind: "has", operand: left, attribute, text: this.textFrom(start) };
    }
    if (this.isIdent("is")) {
      this.i++;
      const entityType = this.typePath();
      if (!this.isIdent("in")) {
        return { kind: "is", operand: left, entityType, text: this.textFrom(start) };
      }
      this.i++;
      const within = this.additive();
      return { kind: "is", operand: left, entityType, within, text: this.textFrom(start) };
    }
    return left;
  }

  private additive(): Expr {
    const start = this.peek();
    let left = this.multiplicative();
    while (this.isPunct("+") || this.isPunct("-")) {
      const op = this.tokens[this.i++]!.value as "+" | "-";
      const right = this.multiplicative();
      left = { kind: "binary", op, left, right, text: this.textFrom(start) };
    }
    return left;
  }

  private multiplicative(): Expr {
    const start = this.peek();
    let left = this.unary();
    while (this.isPunct("*")) {
      this.i++;
      const right = this.unary();
      left = { kind: "binary", op: "*", left, right, text: this.textFrom(start) };
    }
    return left;
  }

  private unary(): Expr {
    const start = this.peek();
    if (this.isPunct("!")) {
      this.i++;
      return { kind: "not", operand: this.unary(), text: this.textFrom(start) };
    }
    if (this.isPunct("-")) {
      this.i++;
      const operand = this.unary();
      if (operand.kind === "literal" && typeof operand.value === "number") {
        return { kind: "literal", value: -operand.value, text: this.textFrom(start) };
      }
      return { kind: "negate", operand, text: this.textFrom(start) };
    }
    return this.member();
  }

  private member(): Expr {
    const start = this.peek();
    let base = this.primary();
    for (;;) {
      if (this.isPunct(".")) {
        this.i++;
        const name = this.expect("ident", "an attribute or method name");
        if (this.isPunct("(")) {
          const args = this.arguments();
          base = {
            kind: "call",
            name: name.value,
            receiver: base,
            args,
            text: this.textFrom(start),
          };
        } else {
          base = { kind: "attribute", object: base, name: name.value, text: this.textFrom(start) };
        }
        continue;
      }
      if (this.isPunct("[")) {
        this.i++;
        const key = this.expr();
        this.expectPunct("]");
        base = { kind: "index", object: base, key, text: this.textFrom(start) };
        continue;
      }
      return base;
    }
  }

  private primary(): Expr {
    const t = this.peek();
    if (t.kind === "string") {
      this.i++;
      return { kind: "literal", value: decodeString(t.value, t.span), text: this.textFrom(t) };
    }
    if (t.kind === "number") {
      this.i++;
      return { kind: "literal", value: Number(t.value), text: t.value };
    }
    if (t.kind === "punct" && t.value === "(") {
      this.i++;
      const inner = this.expr();
      this.expectPunct(")");
      return { ...inner, text: this.textFrom(t) };
    }
    if (t.kind === "punct" && t.value === "[") {
      this.i++;
      const items: Expr[] = [];
      while (!this.isPunct("]")) {
        items.push(this.expr());
        if (!this.isPunct(",")) break;
        this.i++;
      }
      this.expectPunct("]");
      return { kind: "set", items, text: this.textFrom(t) };
    }
    if (t.kind === "punct" && t.value === "{") {
      this.i++;
      const entries: { key: string; value: Expr }[] = [];
      while (!this.isPunct("}")) {
        const key = this.peek();
        if (key.kind !== "ident" && key.kind !== "string") this.fail("expected a record key", key);
        this.i++;
        this.expectPunct(":");
        entries.push({
          key: key.kind === "string" ? decodeString(key.value, key.span) : key.value,
          value: this.expr(),
        });
        if (!this.isPunct(",")) break;
        this.i++;
      }
      this.expectPunct("}");
      return { kind: "record", entries, text: this.textFrom(t) };
    }
    if (t.kind === "ident") {
      if (t.value === "true" || t.value === "false") {
        this.i++;
        return { kind: "literal", value: t.value === "true", text: t.value };
      }
      const next = this.tokens[this.i + 1];
      if (next?.kind === "punct" && next.value === "::") {
        return { kind: "entity", entity: this.entity(), text: this.textFrom(t) };
      }
      if (next?.kind === "punct" && next.value === "(") {
        this.i++;
        const args = this.arguments();
        return { kind: "call", name: t.value, args, text: this.textFrom(t) };
      }
      if (VARIABLES.has(t.value)) {
        this.i++;
        const name = t.value as "principal" | "action" | "resource" | "context";
        return { kind: "variable", name, text: t.value };
      }
    }
    return this.fail(`unexpected ${describe(t)} in a condition`, t);
  }

  private arguments(): Expr[] {
    this.expectPunct("(");
    const args: Expr[] = [];
    while (!this.isPunct(")")) {
      args.push(this.expr());
      if (!this.isPunct(",")) break;
      this.i++;
    }
    this.expectPunct(")");
    return args;
  }

  private entity(): EntityRef {
    const start = this.peek();
    const type = [this.expect("ident", "an entity type").value];
    for (;;) {
      this.expectPunct("::");
      const t = this.peek();
      if (t.kind === "string") {
        this.i++;
        return { type, id: decodeString(t.value, t.span) };
      }
      if (t.kind !== "ident")
        this.fail(`expected an entity, such as Box::Action::"http:request"`, start);
      type.push(t.value);
      this.i++;
    }
  }

  private typePath(): string[] {
    const path = [this.expect("ident", "an entity type").value];
    while (this.isPunct("::")) {
      this.i++;
      path.push(this.expect("ident", "an entity type").value);
    }
    return path;
  }

  private attributeName(): string {
    const t = this.peek();
    if (t.kind === "ident") {
      this.i++;
      return t.value;
    }
    if (t.kind === "string") {
      this.i++;
      return decodeString(t.value, t.span);
    }
    return this.fail("expected an attribute name after has", t);
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private peek(): Token {
    const t = this.tokens[this.i];
    if (t) return t;
    const last = this.tokens.at(-1);
    throw new SyntaxFailure(
      "unexpected end of the policy",
      last
        ? { line: last.span.line, column: last.span.column + (last.end - last.start) }
        : { line: 1, column: 1 },
    );
  }

  private isPunct(value: string): boolean {
    const t = this.tokens[this.i];
    return t?.kind === "punct" && t.value === value;
  }

  private isIdent(value: string): boolean {
    const t = this.tokens[this.i];
    return t?.kind === "ident" && t.value === value;
  }

  private expect(kind: TokenKind, what: string): Token {
    const t = this.peek();
    if (t.kind !== kind) this.fail(`expected ${what}, found ${describe(t)}`, t);
    this.i++;
    return t;
  }

  private expectPunct(value: string): Token {
    const t = this.peek();
    if (t.kind !== "punct" || t.value !== value)
      this.fail(`expected ${value}, found ${describe(t)}`, t);
    this.i++;
    return t;
  }

  private expectIdent(value: string): Token {
    const t = this.peek();
    if (t.kind !== "ident" || t.value !== value)
      this.fail(`expected ${value}, found ${describe(t)}`, t);
    this.i++;
    return t;
  }

  /** The tokens' source text without comments, on one line. */
  private textOf(tokens: readonly Token[]): string {
    let text = "";
    tokens.forEach((t, n) => {
      if (n > 0) {
        const gap = this.source.slice(tokens[n - 1]!.end, t.start);
        text += gap.includes("//") || /\s/.test(gap) ? " " : gap;
      }
      text += this.source.slice(t.start, t.end);
    });
    return text;
  }

  private textFrom(start: Token): string {
    return this.source.slice(start.start, this.tokens[this.i - 1]!.end);
  }

  private fail(message: string, at: Token): never {
    throw new SyntaxFailure(message, at.span);
  }
}

function describe(t: Token): string {
  return t.kind === "string" ? `"${t.value}"` : t.value;
}
