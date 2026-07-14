import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  compareDiagnostics,
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
  legacyFileDigests: readonly LegacyFileDigest[];
}>;

type LegacyFileDigest = Readonly<{
  path: string;
  sha256: string;
}>;

type PathPolicyOptions = Readonly<{
  platform: NodeJS.Platform;
  repositoryRoot: string;
}>;

type VerificationResult = Readonly<{
  exitCode: 0 | 1;
  stdout: readonly string[];
  stderr: readonly string[];
}>;

type VerificationOptions = Readonly<{
  fixture: unknown;
  cwd: string;
  platform: NodeJS.Platform;
  runCommand(command: readonly string[], cwd: string): Promise<CommandResult>;
  readFile(path: string): Promise<Uint8Array>;
}>;

const REQUIRED_TYPESCRIPT_VERSION = "5.9.3";
const REQUIRED_TYPESCRIPT_COMMAND = ["bunx", "tsc", "--noEmit", "--pretty", "false"] as const;
const REQUIRED_DIAGNOSTIC_COUNT = 29;
const REQUIRED_COMPILER_EXIT_CODE = 2;
const UTF8_DECODER_OPTIONS = { fatal: true } as const;
const GENERIC_FAILURE = "TypeScript diagnostic verification failed.";

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareDiagnosticTuples(left: TypeScriptDiagnostic, right: TypeScriptDiagnostic): number {
  return (
    compareStrings(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message)
  );
}

function normalizeRepositoryPath(
  value: string,
  invalidPathMessage: string,
  options: PathPolicyOptions = {
    platform: process.platform,
    repositoryRoot: process.cwd(),
  },
): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(invalidPathMessage);
  }

  if (options.platform === "win32") {
    const repositoryRoot = win32.normalize(options.repositoryRoot);
    const candidate = value.replaceAll("/", "\\");
    const relativePath = win32.isAbsolute(candidate)
      ? win32.relative(repositoryRoot, win32.normalize(candidate))
      : candidate;
    const normalized = win32.normalize(relativePath);
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith(`..${win32.sep}`) ||
      win32.isAbsolute(normalized) ||
      /^[A-Za-z]:/.test(normalized)
    ) {
      throw new Error(invalidPathMessage);
    }
    return normalized.replaceAll("\\", "/");
  }

  const slashPath = value.replaceAll("\\", "/");
  const relativePath = posix.isAbsolute(slashPath)
    ? posix.relative(posix.normalize(options.repositoryRoot), posix.normalize(slashPath))
    : slashPath;
  const normalized = posix.normalize(relativePath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(invalidPathMessage);
  }
  return normalized;
}

function canonicalRepositoryPath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

export function findDiagnosticsInProtectedFiles(
  diagnostics: readonly TypeScriptDiagnostic[],
  protectedPaths: readonly string[],
  options: PathPolicyOptions = {
    platform: process.platform,
    repositoryRoot: process.cwd(),
  },
): readonly TypeScriptDiagnostic[] {
  const normalizedPaths = new Set(
    protectedPaths.map((path) =>
      canonicalRepositoryPath(
        normalizeRepositoryPath(path, "Repository path is invalid.", options),
        options.platform,
      ),
    ),
  );
  return [...diagnostics]
    .filter((diagnostic) =>
      normalizedPaths.has(
        canonicalRepositoryPath(
          normalizeRepositoryPath(diagnostic.path, "Repository path is invalid.", options),
          options.platform,
        ),
      ),
    )
    .sort(compareDiagnosticTuples);
}

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

export function parseBaseline(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): TypeScriptDiagnosticBaseline {
  if (
    !isRecord(value) ||
    value.typescriptVersion !== REQUIRED_TYPESCRIPT_VERSION ||
    !Array.isArray(value.command) ||
    value.command.length !== REQUIRED_TYPESCRIPT_COMMAND.length ||
    !value.command.every((part, index) => part === REQUIRED_TYPESCRIPT_COMMAND[index]) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length !== REQUIRED_DIAGNOSTIC_COUNT ||
    !Array.isArray(value.legacyFileDigests)
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

  const legacyFileDigests = value.legacyFileDigests.map((entry): LegacyFileDigest => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !isNormalizedRepositoryPath(entry.path) ||
      entry.path.toLowerCase().includes("identity") ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Invalid TypeScript diagnostic baseline.");
    }
    return { path: entry.path, sha256: entry.sha256 };
  });

  const diagnosticPaths = new Set(
    diagnostics.map((diagnostic) => canonicalRepositoryPath(diagnostic.path, platform)),
  );
  const digestPaths = new Set(
    legacyFileDigests.map((entry) => canonicalRepositoryPath(entry.path, platform)),
  );
  if (
    digestPaths.size !== legacyFileDigests.length ||
    digestPaths.size !== diagnosticPaths.size ||
    [...diagnosticPaths].some((path) => !digestPaths.has(path))
  ) {
    throw new Error("Invalid TypeScript diagnostic baseline.");
  }

  return {
    typescriptVersion: REQUIRED_TYPESCRIPT_VERSION,
    command: REQUIRED_TYPESCRIPT_COMMAND,
    diagnostics,
    legacyFileDigests,
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

function failure(message = GENERIC_FAILURE): VerificationResult {
  return { exitCode: 1, stdout: [], stderr: [message] };
}

function repositoryFilePath(
  repositoryRoot: string,
  repositoryPath: string,
  platform: NodeJS.Platform,
): string {
  return platform === "win32"
    ? win32.join(repositoryRoot, ...repositoryPath.split("/"))
    : posix.join(repositoryRoot, repositoryPath);
}

async function findChangedLegacyFiles(
  baseline: TypeScriptDiagnosticBaseline,
  repositoryRoot: string,
  platform: NodeJS.Platform,
  readRepositoryFile: VerificationOptions["readFile"],
): Promise<readonly string[]> {
  const changedPaths: string[] = [];
  for (const entry of baseline.legacyFileDigests) {
    const bytes = await readRepositoryFile(
      repositoryFilePath(repositoryRoot, entry.path, platform),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) {
      changedPaths.push(entry.path);
    }
  }
  return changedPaths;
}

export async function verifyTypeScriptDiagnostics(
  options: VerificationOptions,
): Promise<VerificationResult> {
  try {
    const baseline = parseBaseline(options.fixture, options.platform);
    const rootResult = await options.runCommand(
      ["git", "rev-parse", "--show-toplevel"],
      options.cwd,
    );
    if (rootResult.exitCode !== 0 || rootResult.stderr !== "") {
      return failure();
    }
    const repositoryRoot = parseRepositoryRoot(rootResult.stdout);

    const versionResult = await options.runCommand(["bunx", "tsc", "--version"], repositoryRoot);
    if (
      versionResult.exitCode !== 0 ||
      versionResult.stderr !== "" ||
      versionResult.stdout !== `Version ${baseline.typescriptVersion}\n`
    ) {
      return failure("TypeScript version mismatch.");
    }

    const changedLegacyPaths = await findChangedLegacyFiles(
      baseline,
      repositoryRoot,
      options.platform,
      options.readFile,
    );
    const compilerResult = await options.runCommand(baseline.command, repositoryRoot);
    if (compilerResult.exitCode !== REQUIRED_COMPILER_EXIT_CODE || compilerResult.stderr !== "") {
      return failure();
    }

    const actualDiagnostics = parseDiagnostics(compilerResult.stdout);
    const protectedDiagnostics = findDiagnosticsInProtectedFiles(
      actualDiagnostics,
      changedLegacyPaths,
      {
        platform: options.platform,
        repositoryRoot,
      },
    );
    if (protectedDiagnostics.length > 0) {
      return failure("Reviewed legacy TypeScript file changed.");
    }

    const comparison = compareDiagnostics(baseline.diagnostics, actualDiagnostics);
    if (comparison.kind === "mismatched") {
      return failure("TypeScript diagnostic baseline mismatch.");
    }

    return {
      exitCode: 0,
      stdout: [
        "TypeScript diagnostic baseline matched: 29 diagnostics.",
        "Reviewed legacy diagnostic files unchanged: 3 files.",
        "Non-baseline TypeScript files clean: 0 diagnostics.",
      ],
      stderr: [],
    };
  } catch {
    return failure();
  }
}

async function main(): Promise<void> {
  const result = await verifyTypeScriptDiagnostics({
    fixture: baselineFixture,
    cwd: process.cwd(),
    platform: process.platform,
    runCommand,
    readFile,
  });
  for (const line of result.stdout) {
    console.log(line);
  }
  for (const line of result.stderr) {
    console.error(line);
  }
  process.exitCode = result.exitCode;
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(GENERIC_FAILURE);
    process.exitCode = 1;
  }
}
