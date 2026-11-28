import { describe, expect, test } from "bun:test";
import { HandlebarsTemplateRenderer } from "../templates/renderer";
import { escapePythonTripleQuoted } from "./baseTranslator";

// Decodes the body of a Python """...""" literal the way Python's tokenizer
// does for the escapes these helpers emit: a backslash escapes the next
// character, and the first unescaped """ closes the string. Returns the
// decoded value and whatever follows the closing delimiter, which Python
// would treat as more source (a trailing "" silently concatenates as an
// empty string, so the literal still compiles but loses the quotes).
function parsePythonTripleQuoted(body: string): { value: string; rest: string } {
  const source = `${body}"""`;
  let value = "";
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") {
      value += source[++i];
    } else if (source.startsWith('"""', i)) {
      return { value, rest: source.slice(i + 3) };
    } else {
      value += source[i];
    }
  }
  throw new Error("unterminated triple-quoted literal");
}

const python3 = Bun.which("python3");

// Evaluates SYSTEM_PROMPT = """<body>""" with a real interpreter and returns
// the resulting string.
function evalWithPython(body: string): string {
  const result = Bun.spawnSync(
    [
      python3!,
      "-c",
      "import sys; ns = {}; exec(sys.stdin.read(), ns); sys.stdout.write(ns['SYSTEM_PROMPT'])",
    ],
    { stdin: Buffer.from(`SYSTEM_PROMPT = """${body}"""\n`) },
  );
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

const renderer = new HandlebarsTemplateRenderer();
const escapers: [string, (value: string) => string][] = [
  ["escapePythonTripleQuoted", escapePythonTripleQuoted],
  ["escapePyStr", (value) => renderer.render("{{escapePyStr v}}", { v: value })],
];

// Before the fix, `Keep both quotes: ""` compiled but the trailing "" fused
// with the closing delimiter and was dropped; a syntax check alone misses it.
const roundTripPrompts = [
  'Keep both quotes: ""',
  'ends in one "',
  'emit """ here',
  "back\\slash\\",
];

describe.each(escapers)("%s round-trips through a Python triple-quoted literal", (_, escape) => {
  test.each(roundTripPrompts)("%p", (prompt) => {
    expect(parsePythonTripleQuoted(escape(prompt))).toEqual({ value: prompt, rest: "" });
  });

  test.skipIf(!python3).each(roundTripPrompts)("%p (python3)", (prompt) => {
    expect(evalWithPython(escape(prompt))).toBe(prompt);
  });
});

// escapePythonTripleQuoted escapes a value for embedding inside a Python
// triple-double-quoted literal: SYSTEM_PROMPT = """<escaped>""". For the result
// to be a valid literal, no double-quote in the value may abut the closing
// delimiter — a trailing `"` (or `""`) merges with `"""` into `""""`, which
// Python reads as a closed string plus a dangling quote (a syntax error).
describe("escapePythonTripleQuoted", () => {
  test("escapes a trailing double-quote so it does not merge with the closing delimiter", () => {
    const escaped = escapePythonTripleQuoted('Always answer in "quotes"');
    // Embedded as """<escaped>""", a trailing unescaped quote merges with the
    // closing delimiter into """" and breaks the literal; the quote must be escaped.
    expect(escaped).toBe('Always answer in \\"quotes\\"');
  });

  test("still escapes an interior triple-quote run", () => {
    expect(escapePythonTripleQuoted('emit """ here')).toBe('emit \\"\\"\\" here');
  });
});
