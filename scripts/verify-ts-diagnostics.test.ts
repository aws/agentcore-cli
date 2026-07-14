import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDiagnosticsInProtectedFiles,
  parseBaseline,
  verifyTypeScriptDiagnostics,
} from "./verify-ts-diagnostics";
import baselineFixture from "../test/fixtures/typescript-diagnostics.json";

const diagnostic = {
  path: "src/example.ts",
  line: 1,
  column: 1,
  code: "TS2532" as const,
  message: "Example.",
};

const validFixture = baselineFixture;
const compilerStdout = baselineFixture.diagnostics
  .map(
    (entry) =>
      `${entry.path}(${entry.line},${entry.column}): error ${entry.code}: ${entry.message.replaceAll(
        "\n",
        "\n  ",
      )}`,
  )
  .join("\n");

describe("TypeScript diagnostic path policy", () => {
  test("matches protected paths case-insensitively on Windows", () => {
    expect(
      findDiagnosticsInProtectedFiles([diagnostic], ["SRC\\EXAMPLE.TS"], {
        platform: "win32",
        repositoryRoot: "C:\\repo",
      }),
    ).toEqual([diagnostic]);
  });

  test("normalizes an in-repository UNC path and rejects another share", () => {
    const options = {
      platform: "win32" as const,
      repositoryRoot: "\\\\server\\share\\repo",
    };

    expect(
      findDiagnosticsInProtectedFiles(
        [diagnostic],
        ["\\\\SERVER\\SHARE\\REPO\\SRC\\EXAMPLE.TS"],
        options,
      ),
    ).toEqual([diagnostic]);
    expect(() =>
      findDiagnosticsInProtectedFiles(
        [diagnostic],
        ["\\\\server\\other\\repo\\src\\example.ts"],
        options,
      ),
    ).toThrow("Repository path is invalid.");
  });
});

describe("TypeScript diagnostic fixture", () => {
  test("accepts the reviewed digest manifest", () => {
    expect(() => parseBaseline(validFixture)).not.toThrow();
  });

  test("rejects malformed or incomplete digest manifests", () => {
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: validFixture.legacyFileDigests.slice(1),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: [...validFixture.legacyFileDigests, validFixture.legacyFileDigests[0]],
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: validFixture.legacyFileDigests.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "not-a-sha256" } : entry,
        ),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: validFixture.legacyFileDigests.map((entry, index) =>
          index === 0 ? { ...entry, path: "src/components/ui/other.ts" } : entry,
        ),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: validFixture.diagnostics.slice(1),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });

  test("rejects Identity paths in the legacy digest allowlist", () => {
    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: baselineFixture.diagnostics.map((entry, index) =>
          index === 0 ? { ...entry, path: "src/core/identity/legacy.ts" } : entry,
        ),
        legacyFileDigests: [
          ...validFixture.legacyFileDigests.slice(1),
          {
            path: "src/core/identity/legacy.ts",
            sha256: "0".repeat(64),
          },
        ],
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });
});

describe("TypeScript diagnostic verifier", () => {
  function createCommandRunner(
    compilerResult: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
  ) {
    const calls: Array<Readonly<{ command: readonly string[]; cwd: string }>> = [];
    return {
      calls,
      runCommand: async (command: readonly string[], cwd: string) => {
        calls.push({ command, cwd });
        if (command[0] === "git") {
          return { exitCode: 0, stdout: `${process.cwd()}\n`, stderr: "" };
        }
        if (command.at(-1) === "--version") {
          return { exitCode: 0, stdout: "Version 5.9.3\n", stderr: "" };
        }
        return compilerResult;
      },
    };
  }

  test("orchestrates the exact production commands without a historical Git base", async () => {
    const commands = createCommandRunner({ exitCode: 2, stdout: compilerStdout, stderr: "" });
    const result = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: commands.runCommand,
      readFile,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        "TypeScript diagnostic baseline matched: 29 diagnostics.",
        "Reviewed legacy diagnostic files unchanged: 3 files.",
        "Non-baseline TypeScript files clean: 0 diagnostics.",
      ],
      stderr: [],
    });
    expect(commands.calls).toEqual([
      {
        command: ["git", "rev-parse", "--show-toplevel"],
        cwd: process.cwd(),
      },
      {
        command: ["bunx", "tsc", "--version"],
        cwd: process.cwd(),
      },
      {
        command: ["bunx", "tsc", "--noEmit", "--pretty", "false"],
        cwd: process.cwd(),
      },
    ]);
  });

  test.each([
    { name: "exit 137", exitCode: 137, stdout: compilerStdout, stderr: "" },
    { name: "wrong diagnostic exit", exitCode: 1, stdout: compilerStdout, stderr: "" },
    { name: "stderr", exitCode: 2, stdout: compilerStdout, stderr: "secret stderr" },
    {
      name: "crash text",
      exitCode: 2,
      stdout: `${compilerStdout}\nfatal: compiler crashed`,
      stderr: "",
    },
  ])("rejects incomplete compiler execution: $name", async ({ exitCode, stdout, stderr }) => {
    const commands = createCommandRunner({ exitCode, stdout, stderr });
    const result = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: commands.runCommand,
      readFile,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual(["TypeScript diagnostic verification failed."]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("fatal");
  });

  test("rejects diagnostics from a changed reviewed legacy file", async () => {
    const commands = createCommandRunner({ exitCode: 2, stdout: compilerStdout, stderr: "" });
    const result = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: commands.runCommand,
      readFile: async (path) =>
        path.endsWith(join("data-table", "DataTable.tsx"))
          ? new TextEncoder().encode("changed legacy file")
          : readFile(path),
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ["Reviewed legacy TypeScript file changed."],
    });
  });

  test("keeps malformed fixtures and unknown failures static and secret-safe", async () => {
    const commands = createCommandRunner({ exitCode: 2, stdout: compilerStdout, stderr: "" });
    const malformedResult = await verifyTypeScriptDiagnostics({
      fixture: { ...validFixture, legacyFileDigests: [] },
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: commands.runCommand,
      readFile,
    });
    const unknownResult = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: async () => {
        throw new Error("unknown secret");
      },
      readFile,
    });

    expect(malformedResult).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ["TypeScript diagnostic verification failed."],
    });
    expect(unknownResult).toEqual(malformedResult);
    expect(JSON.stringify(unknownResult)).not.toContain("unknown secret");
  });

  test("runs the actual verifier entrypoint with static output", async () => {
    const child = Bun.spawn([process.execPath, "scripts/verify-ts-diagnostics.ts"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      [
        "TypeScript diagnostic baseline matched: 29 diagnostics.",
        "Reviewed legacy diagnostic files unchanged: 3 files.",
        "Non-baseline TypeScript files clean: 0 diagnostics.",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
  }, 20_000);

  test("keeps actual entrypoint failures static", async () => {
    const scriptPath = join(process.cwd(), "scripts", "verify-ts-diagnostics.ts");
    const child = Bun.spawn([process.execPath, scriptPath], {
      cwd: tmpdir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("TypeScript diagnostic verification failed.\n");
  });
});
