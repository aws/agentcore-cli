import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  collectProtectedTypeScriptPaths,
  compareDiagnostics,
  findDiagnosticsInProtectedFiles,
  parseDiagnostics,
  type TypeScriptDiagnostic,
} from "../src/testing/typescriptDiagnostics";
import baselineFixture from "../test/fixtures/typescript-diagnostics.json";

type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type TypeScriptDiagnosticBaseline = Readonly<{
  typescriptVersion: "5.9.3";
  command: readonly ["bunx", "tsc", "--noEmit", "--pretty", "false"];
  diagnostics: readonly TypeScriptDiagnostic[];
}>;

const REQUIRED_TYPESCRIPT_VERSION = "5.9.3";
const REQUIRED_TYPESCRIPT_COMMAND = ["bunx", "tsc", "--noEmit", "--pretty", "false"] as const;
const IDENTITY_FEATURE_BASE = "ef2734b9752f3d0c2905de18f8996fab0a55a0c8";
const UTF8_DECODER_OPTIONS = { fatal: true } as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.replaceAll("\\", "/") &&
    value === posix.normalize(value) &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

function parseBaseline(value: unknown): TypeScriptDiagnosticBaseline {
  if (
    !isRecord(value) ||
    value.typescriptVersion !== REQUIRED_TYPESCRIPT_VERSION ||
    !Array.isArray(value.command) ||
    value.command.length !== REQUIRED_TYPESCRIPT_COMMAND.length ||
    !value.command.every((part, index) => part === REQUIRED_TYPESCRIPT_COMMAND[index]) ||
    !Array.isArray(value.diagnostics)
  ) {
    throw new Error("Invalid TypeScript diagnostic baseline.");
  }

  const diagnostics = value.diagnostics.map((diagnostic): TypeScriptDiagnostic => {
    if (
      !isRecord(diagnostic) ||
      typeof diagnostic.path !== "string" ||
      !isNormalizedRepositoryPath(diagnostic.path) ||
      typeof diagnostic.line !== "number" ||
      !Number.isSafeInteger(diagnostic.line) ||
      diagnostic.line < 1 ||
      typeof diagnostic.column !== "number" ||
      !Number.isSafeInteger(diagnostic.column) ||
      diagnostic.column < 1 ||
      typeof diagnostic.code !== "string" ||
      !/^TS\d+$/.test(diagnostic.code) ||
      typeof diagnostic.message !== "string"
    ) {
      throw new Error("Invalid TypeScript diagnostic baseline.");
    }
    return {
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code as `TS${number}`,
      message: diagnostic.message,
    };
  });

  return {
    typescriptVersion: REQUIRED_TYPESCRIPT_VERSION,
    command: REQUIRED_TYPESCRIPT_COMMAND,
    diagnostics,
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", UTF8_DECODER_OPTIONS).decode(bytes);
}

async function runCommand(command: readonly string[], cwd: string): Promise<CommandResult> {
  const captureRoot = await mkdtemp(join(tmpdir(), "agentcore-ts-diagnostics-"));
  const stdoutPath = join(captureRoot, "stdout.txt");
  const stderrPath = join(captureRoot, "stderr.txt");
  try {
    const child = Bun.spawn([...command], {
      cwd,
      stdin: "ignore",
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await child.exited;
    const [stdoutBytes, stderrBytes] = await Promise.all([
      readFile(stdoutPath),
      readFile(stderrPath),
    ]);
    return {
      exitCode,
      stdout: decodeUtf8(stdoutBytes),
      stderr: decodeUtf8(stderrBytes),
    };
  } finally {
    await rm(captureRoot, { recursive: true, force: true });
  }
}

async function requireSuccessfulCommand(command: readonly string[], cwd: string): Promise<string> {
  const result = await runCommand(command, cwd);
  if (result.exitCode !== 0 || result.stderr !== "") {
    throw new Error("Command failed.");
  }
  return result.stdout;
}

function parseRepositoryRoot(output: string): string {
  if (!output.endsWith("\n")) {
    throw new Error("Git root discovery failed.");
  }
  const root = output.slice(0, -1);
  if (root.length === 0 || root.includes("\0") || root.includes("\n") || root.includes("\r")) {
    throw new Error("Git root discovery failed.");
  }
  return root;
}

function parseNullDelimitedPaths(output: string): readonly string[] {
  if (output === "") {
    return [];
  }
  if (!output.endsWith("\0")) {
    throw new Error("Git path discovery failed.");
  }
  const paths = output.slice(0, -1).split("\0");
  if (paths.some((path) => path.length === 0)) {
    throw new Error("Git path discovery failed.");
  }
  return paths;
}

async function discoverProtectedPaths(repositoryRoot: string): Promise<readonly string[]> {
  await requireSuccessfulCommand(
    ["git", "merge-base", "--is-ancestor", IDENTITY_FEATURE_BASE, "HEAD"],
    repositoryRoot,
  );

  const [repositoryOutput, branchOutput, indexOutput, worktreeOutput, untrackedOutput] =
    await Promise.all([
      requireSuccessfulCommand(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        repositoryRoot,
      ),
      requireSuccessfulCommand(
        [
          "git",
          "diff",
          "--no-ext-diff",
          "--name-only",
          "--diff-filter=d",
          "-z",
          IDENTITY_FEATURE_BASE,
          "HEAD",
        ],
        repositoryRoot,
      ),
      requireSuccessfulCommand(
        ["git", "diff", "--no-ext-diff", "--cached", "--name-only", "--diff-filter=d", "-z"],
        repositoryRoot,
      ),
      requireSuccessfulCommand(
        ["git", "diff", "--no-ext-diff", "--name-only", "--diff-filter=d", "-z"],
        repositoryRoot,
      ),
      requireSuccessfulCommand(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        repositoryRoot,
      ),
    ]);

  return collectProtectedTypeScriptPaths({
    kind: "succeeded",
    repositoryPaths: parseNullDelimitedPaths(repositoryOutput),
    touchedPaths: [
      ...parseNullDelimitedPaths(branchOutput),
      ...parseNullDelimitedPaths(indexOutput),
      ...parseNullDelimitedPaths(worktreeOutput),
      ...parseNullDelimitedPaths(untrackedOutput),
    ],
  });
}

function combineCompilerOutput(result: CommandResult): string {
  if (result.stdout === "" || result.stderr === "") {
    return `${result.stdout}${result.stderr}`;
  }
  return `${result.stdout}${result.stdout.endsWith("\n") ? "" : "\n"}${result.stderr}`;
}

function printDiagnostics(diagnostics: readonly TypeScriptDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    console.error(
      JSON.stringify([
        diagnostic.path,
        diagnostic.line,
        diagnostic.column,
        diagnostic.code,
        diagnostic.message,
      ]),
    );
  }
}

async function main(): Promise<void> {
  const baseline = parseBaseline(baselineFixture);
  const repositoryRoot = parseRepositoryRoot(
    await requireSuccessfulCommand(["git", "rev-parse", "--show-toplevel"], process.cwd()),
  );
  const versionResult = await runCommand(["bunx", "tsc", "--version"], repositoryRoot);
  if (
    versionResult.exitCode !== 0 ||
    versionResult.stderr !== "" ||
    versionResult.stdout.trim() !== `Version ${baseline.typescriptVersion}`
  ) {
    console.error("TypeScript version mismatch.");
    process.exitCode = 1;
    return;
  }

  process.chdir(repositoryRoot);
  const protectedPaths = await discoverProtectedPaths(repositoryRoot);
  const compilerResult = await runCommand(baseline.command, repositoryRoot);
  const actualDiagnostics = parseDiagnostics(combineCompilerOutput(compilerResult));
  const comparison = compareDiagnostics(baseline.diagnostics, actualDiagnostics);
  const protectedDiagnostics = findDiagnosticsInProtectedFiles(actualDiagnostics, protectedPaths);
  let failed = false;

  if (comparison.kind === "mismatched") {
    console.error("TypeScript diagnostic baseline mismatch.");
    if (comparison.missing.length > 0) {
      console.error("Missing diagnostics:");
      printDiagnostics(comparison.missing);
    }
    if (comparison.unexpected.length > 0) {
      console.error("Unexpected diagnostics:");
      printDiagnostics(comparison.unexpected);
    }
    failed = true;
  }

  if (protectedDiagnostics.length > 0) {
    console.error("Diagnostics in protected TypeScript files:");
    printDiagnostics(protectedDiagnostics);
    failed = true;
  }

  const compilerExitMatchesDiagnostics =
    (actualDiagnostics.length === 0 && compilerResult.exitCode === 0) ||
    (actualDiagnostics.length > 0 && compilerResult.exitCode !== 0);
  if (!compilerExitMatchesDiagnostics) {
    console.error("TypeScript compiler exit status mismatch.");
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(`TypeScript diagnostic baseline matched: ${actualDiagnostics.length} diagnostics.`);
  console.log(`Protected TypeScript files clean: ${protectedPaths.length} files, 0 diagnostics.`);
}

try {
  await main();
} catch {
  console.error("TypeScript diagnostic verification failed.");
  process.exitCode = 1;
}
