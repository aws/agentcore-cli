import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as ts from "typescript";
import { compareDiagnostics, parseDiagnostics } from "./typescriptDiagnostics";
import * as typescriptDiagnostics from "./typescriptDiagnostics";

describe("TypeScript diagnostic baseline", () => {
  const line = "src/a.ts(2,7): error TS2532: Object is possibly 'undefined'.";

  test("exposes only the approved runtime values", () => {
    expect(Object.keys(typescriptDiagnostics).sort()).toEqual([
      "compareDiagnostics",
      "parseDiagnostics",
    ]);
  });

  test("exposes only the approved declaration surface", () => {
    const sourcePath = join(process.cwd(), "src", "testing", "typescriptDiagnostics.ts");
    const program = ts.createProgram([sourcePath], {
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    });
    const sourceFile = program.getSourceFile(sourcePath);
    if (sourceFile === undefined) {
      throw new Error("TypeScript diagnostic module was not loaded.");
    }
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) {
      throw new Error("TypeScript diagnostic module symbol was not found.");
    }

    expect(
      checker
        .getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.getName())
        .sort(),
    ).toEqual([
      "DiagnosticComparison",
      "TypeScriptDiagnostic",
      "compareDiagnostics",
      "parseDiagnostics",
    ]);
  });

  test("normalizes one compiler diagnostic", () => {
    expect(parseDiagnostics(line)).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        column: 7,
        code: "TS2532",
        message: "Object is possibly 'undefined'.",
      },
    ]);
  });

  test("rejects a moved, changed, added, or missing diagnostic", () => {
    const baseline = parseDiagnostics(line);
    expect(compareDiagnostics(baseline, baseline)).toEqual({ kind: "matched" });
    expect(
      compareDiagnostics(baseline, parseDiagnostics(line.replace("(2,7)", "(3,7)"))).kind,
    ).toBe("mismatched");
    expect(
      compareDiagnostics(baseline, parseDiagnostics(line.replace("TS2532", "TS18048"))).kind,
    ).toBe("mismatched");
    expect(
      compareDiagnostics(baseline, parseDiagnostics(line.replace("Object", "Value"))).kind,
    ).toBe("mismatched");
    expect(compareDiagnostics(baseline, [...baseline, ...baseline]).kind).toBe("mismatched");
    expect(compareDiagnostics(baseline, []).kind).toBe("mismatched");
  });

  test("normalizes Windows separators and repository-absolute paths", () => {
    const absolutePath = join(process.cwd(), "src", "absolute.ts");
    const diagnostics = parseDiagnostics(
      [
        "src\\windows.ts(3,4): error TS2532: Windows path.",
        `${absolutePath}(1,2): error TS18048: Absolute path.`,
      ].join("\n"),
    );

    expect(diagnostics).toEqual([
      {
        path: "src/absolute.ts",
        line: 1,
        column: 2,
        code: "TS18048",
        message: "Absolute path.",
      },
      {
        path: "src/windows.ts",
        line: 3,
        column: 4,
        code: "TS2532",
        message: "Windows path.",
      },
    ]);
  });

  test("safely rejects absolute paths outside the repository", () => {
    expect(() => parseDiagnostics("/outside-repository/a.ts(1,2): error TS2532: Outside.")).toThrow(
      "Diagnostic path is outside the repository.",
    );
    expect(() =>
      parseDiagnostics("Z:\\outside-repository\\a.ts(1,2): error TS2532: Outside."),
    ).toThrow("Diagnostic path is outside the repository.");
  });

  test("captures complete multiline diagnostic messages", () => {
    expect(
      parseDiagnostics(
        [
          "src/a.ts(2,7): error TS2345: Argument is not assignable.",
          "  Type 'undefined' is not assignable to type 'number'.",
          "    The target requires a number.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        column: 7,
        code: "TS2345",
        message:
          "Argument is not assignable.\nType 'undefined' is not assignable to type 'number'.\nThe target requires a number.",
      },
    ]);
  });

  test("compares duplicate tuples as a multiset", () => {
    const one = parseDiagnostics(line);
    const two = parseDiagnostics(`${line}\n${line}`);

    expect(compareDiagnostics(two, one)).toEqual({
      kind: "mismatched",
      missing: one,
      unexpected: [],
    });
    expect(compareDiagnostics(one, two)).toEqual({
      kind: "mismatched",
      missing: [],
      unexpected: one,
    });
  });

  test("sorts diagnostics by their complete normalized tuple", () => {
    const diagnostics = parseDiagnostics(
      [
        "src/b.ts(1,1): error TS2532: B.",
        "src/a.ts(2,1): error TS2532: Later.",
        "src/a.ts(1,2): error TS2532: Column.",
        "src/a.ts(1,1): error TS2532: First.",
      ].join("\n"),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "First.",
      "Column.",
      "Later.",
      "B.",
    ]);
  });

  test("rejects every unconsumed nonempty compiler output line", () => {
    expect(() => parseDiagnostics("bunx notice")).toThrow(
      "Unsupported TypeScript compiler output.",
    );
    expect(() => parseDiagnostics(`${line}\nfatal: compiler crashed`)).toThrow(
      "Unsupported TypeScript compiler output.",
    );
    expect(parseDiagnostics("\n")).toEqual([]);
  });

  test("fails closed for unsupported compiler diagnostic formats", () => {
    expect(() => parseDiagnostics("error TS5058: The specified path does not exist.")).toThrow(
      "Unsupported TypeScript diagnostic format.",
    );
  });
});
