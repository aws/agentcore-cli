import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  collectProtectedTypeScriptPaths,
  findDiagnosticsInProtectedFiles,
} from "../../scripts/verify-ts-diagnostics";
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

  test("does not mistake malformed or non-diagnostic output for diagnostics", () => {
    expect(
      parseDiagnostics(
        [
          "bunx notice",
          "src/a.ts(two,7): warning TS2532: Not a compiler diagnostic.",
          "src/a.ts(2,7): info TS2532: Not an error.",
          "Found no diagnostics.",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("fails closed for unsupported compiler diagnostic formats", () => {
    expect(() => parseDiagnostics("error TS5058: The specified path does not exist.")).toThrow(
      "Unsupported TypeScript diagnostic format.",
    );
  });
});

describe("protected TypeScript files", () => {
  test("deterministically includes every Identity and touched TypeScript file", () => {
    const protectedPaths = collectProtectedTypeScriptPaths({
      kind: "succeeded",
      repositoryPaths: [
        "src/core/identity/provider.ts",
        "src/components/IdentityView.tsx",
        "src/unrelated.ts",
        "src/core/identity/readme.md",
      ],
      touchedPaths: [
        "src/z.ts",
        "src/a.cts",
        "src/module.mts",
        "src/z.ts",
        "src/not-typescript.js",
        "src\\windows.tsx",
      ],
    });

    expect(protectedPaths).toEqual([
      "src/a.cts",
      "src/components/IdentityView.tsx",
      "src/core/identity/provider.ts",
      "src/module.mts",
      "src/windows.tsx",
      "src/z.ts",
    ]);

    const diagnostics = parseDiagnostics(
      [
        "src/unrelated.ts(1,1): error TS2532: Existing baseline.",
        "src/z.ts(2,1): error TS2532: Touched.",
        "src/core/identity/provider.ts(3,1): error TS2532: Identity.",
      ].join("\n"),
    );

    expect(findDiagnosticsInProtectedFiles(diagnostics, protectedPaths)).toEqual([
      {
        path: "src/core/identity/provider.ts",
        line: 3,
        column: 1,
        code: "TS2532",
        message: "Identity.",
      },
      {
        path: "src/z.ts",
        line: 2,
        column: 1,
        code: "TS2532",
        message: "Touched.",
      },
    ]);
  });

  test("fails closed when Git or path discovery is unsafe", () => {
    expect(() => collectProtectedTypeScriptPaths({ kind: "failed" })).toThrow(
      "TypeScript path discovery failed.",
    );
    expect(() =>
      collectProtectedTypeScriptPaths({
        kind: "succeeded",
        repositoryPaths: [],
        touchedPaths: ["../outside.ts"],
      }),
    ).toThrow("Repository path is invalid.");
  });
});
