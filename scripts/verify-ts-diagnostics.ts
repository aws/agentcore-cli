import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, type FileHandle } from "node:fs/promises";
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
  fileSystem?: BaselineFileSystem;
}>;

type BaselineFileSystem = Readonly<{
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<FileHandle>;
}>;

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type DirectorySnapshot = Readonly<{
  path: string;
  resolvedPath: string;
  identity: FileIdentity;
}>;

type LegacyFileLease = Readonly<{
  entry: LegacyFileDigest;
  path: string;
  resolvedPath: string;
  identity: FileIdentity;
  digest: string;
  handle: FileHandle;
  parentDirectories: readonly DirectorySnapshot[];
}>;

const REQUIRED_TYPESCRIPT_VERSION = "5.9.3";
const REQUIRED_TYPESCRIPT_COMMAND = ["bunx", "tsc", "--noEmit", "--pretty", "false"] as const;
const REQUIRED_DIAGNOSTIC_COUNT = 29;
const REQUIRED_COMPILER_EXIT_CODE = 2;
const REVIEWED_LEGACY_FILE_DIGESTS = [
  {
    path: "src/components/ui/data-table/DataTable.tsx",
    sha256: "df3eb3532a8ee78b78fbee0356c7e3f6febd9add12bf60e74edcca65141121d3",
  },
  {
    path: "src/components/ui/markdown/Markdown.tsx",
    sha256: "5453b2ad274a3a93849edbce5e3507f088645662d2a4b5687fa593093d6e9770",
  },
  {
    path: "src/components/ui/tabs/Tabs.tsx",
    sha256: "2112b4f26d3650b670a81e1070f4eb093f3075b119862abd6b2750bf10e35dc6",
  },
] as const satisfies readonly LegacyFileDigest[];
const UTF8_DECODER_OPTIONS = { fatal: true } as const;
const GENERIC_FAILURE = "TypeScript diagnostic verification failed.";
const DEFAULT_BASELINE_FILE_SYSTEM: BaselineFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  open,
};

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

  if (
    diagnostics.some(
      (diagnostic, index) =>
        index > 0 &&
        compareDiagnosticTuples(diagnostics[index - 1] as TypeScriptDiagnostic, diagnostic) > 0,
    ) ||
    legacyFileDigests.some(
      (entry, index) =>
        index > 0 &&
        compareStrings((legacyFileDigests[index - 1] as LegacyFileDigest).path, entry.path) > 0,
    ) ||
    legacyFileDigests.length !== REVIEWED_LEGACY_FILE_DIGESTS.length ||
    legacyFileDigests.some(
      (entry, index) =>
        entry.path !== REVIEWED_LEGACY_FILE_DIGESTS[index]?.path ||
        entry.sha256 !== REVIEWED_LEGACY_FILE_DIGESTS[index]?.sha256,
    )
  ) {
    throw new Error("Invalid TypeScript diagnostic baseline.");
  }

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

function fileIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function canonicalAbsolutePath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.normalize(path).toLowerCase() : posix.normalize(path);
}

function requireResolvedPathWithinRepository(
  resolvedPath: string,
  resolvedRepositoryRoot: string,
  platform: NodeJS.Platform,
): void {
  const pathApi = platform === "win32" ? win32 : posix;
  const relativePath = pathApi.relative(resolvedRepositoryRoot, resolvedPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  ) {
    throw new Error("Reviewed legacy TypeScript path is unsafe.");
  }
}

async function hashFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return hash.digest("hex");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function captureParentDirectories(
  entry: LegacyFileDigest,
  repositoryRoot: string,
  resolvedRepositoryRoot: string,
  platform: NodeJS.Platform,
  fileSystem: BaselineFileSystem,
): Promise<readonly DirectorySnapshot[]> {
  const pathApi = platform === "win32" ? win32 : posix;
  const paths = [repositoryRoot];
  let currentPath = repositoryRoot;
  for (const component of entry.path.split("/").slice(0, -1)) {
    currentPath = pathApi.join(currentPath, component);
    paths.push(currentPath);
  }

  const snapshots: DirectorySnapshot[] = [];
  for (const [index, path] of paths.entries()) {
    const statsBefore = await fileSystem.lstat(path);
    const resolvedPath = await fileSystem.realpath(path);
    const statsAfter = await fileSystem.lstat(path);
    if (
      !statsBefore.isDirectory() ||
      !statsAfter.isDirectory() ||
      !identitiesMatch(fileIdentity(statsBefore), fileIdentity(statsAfter))
    ) {
      throw new Error("Reviewed legacy TypeScript parent path is unsafe.");
    }
    if (index === 0) {
      if (
        canonicalAbsolutePath(resolvedPath, platform) !==
        canonicalAbsolutePath(resolvedRepositoryRoot, platform)
      ) {
        throw new Error("Repository root changed during verification.");
      }
    } else {
      requireResolvedPathWithinRepository(resolvedPath, resolvedRepositoryRoot, platform);
    }
    snapshots.push({
      path,
      resolvedPath,
      identity: fileIdentity(statsAfter),
    });
  }
  return snapshots;
}

async function validateParentDirectories(
  snapshots: readonly DirectorySnapshot[],
  resolvedRepositoryRoot: string,
  platform: NodeJS.Platform,
  fileSystem: BaselineFileSystem,
): Promise<void> {
  for (const [index, snapshot] of snapshots.entries()) {
    const stats = await fileSystem.lstat(snapshot.path);
    const resolvedPath = await fileSystem.realpath(snapshot.path);
    if (
      !stats.isDirectory() ||
      !identitiesMatch(snapshot.identity, fileIdentity(stats)) ||
      canonicalAbsolutePath(snapshot.resolvedPath, platform) !==
        canonicalAbsolutePath(resolvedPath, platform)
    ) {
      throw new Error("Reviewed legacy TypeScript parent path changed.");
    }
    if (index === 0) {
      if (
        canonicalAbsolutePath(resolvedPath, platform) !==
        canonicalAbsolutePath(resolvedRepositoryRoot, platform)
      ) {
        throw new Error("Repository root changed during verification.");
      }
    } else {
      requireResolvedPathWithinRepository(resolvedPath, resolvedRepositoryRoot, platform);
    }
  }
}

async function acquireLegacyFileLease(
  entry: LegacyFileDigest,
  repositoryRoot: string,
  resolvedRepositoryRoot: string,
  platform: NodeJS.Platform,
  fileSystem: BaselineFileSystem,
): Promise<LegacyFileLease> {
  const path = repositoryFilePath(repositoryRoot, entry.path, platform);
  const parentDirectories = await captureParentDirectories(
    entry,
    repositoryRoot,
    resolvedRepositoryRoot,
    platform,
    fileSystem,
  );
  const pathStatsBefore = await fileSystem.lstat(path);
  if (!pathStatsBefore.isFile()) {
    throw new Error("Reviewed legacy TypeScript path is not a regular file.");
  }
  const resolvedPathBefore = await fileSystem.realpath(path);
  requireResolvedPathWithinRepository(resolvedPathBefore, resolvedRepositoryRoot, platform);

  const handle = await fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [handleStatsBefore, pathStatsAfter, resolvedPathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      fileSystem.lstat(path),
      fileSystem.realpath(path),
    ]);
    if (
      !handleStatsBefore.isFile() ||
      !pathStatsAfter.isFile() ||
      !identitiesMatch(fileIdentity(pathStatsBefore), fileIdentity(handleStatsBefore)) ||
      !identitiesMatch(fileIdentity(handleStatsBefore), fileIdentity(pathStatsAfter)) ||
      canonicalAbsolutePath(resolvedPathBefore, platform) !==
        canonicalAbsolutePath(resolvedPathAfter, platform)
    ) {
      throw new Error("Reviewed legacy TypeScript file changed during acquisition.");
    }
    requireResolvedPathWithinRepository(resolvedPathAfter, resolvedRepositoryRoot, platform);

    const identity = fileIdentity(handleStatsBefore);
    const digest = await hashFileHandle(handle);
    const [handleStatsAfterHash, pathStatsAfterHash] = await Promise.all([
      handle.stat({ bigint: true }),
      fileSystem.lstat(path),
    ]);
    if (
      !handleStatsAfterHash.isFile() ||
      !pathStatsAfterHash.isFile() ||
      !identitiesMatch(identity, fileIdentity(handleStatsAfterHash)) ||
      !identitiesMatch(identity, fileIdentity(pathStatsAfterHash))
    ) {
      throw new Error("Reviewed legacy TypeScript file changed while hashing.");
    }

    return {
      entry,
      path,
      resolvedPath: resolvedPathAfter,
      identity,
      digest,
      handle,
      parentDirectories,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validateLegacyFileIdentity(
  lease: LegacyFileLease,
  resolvedRepositoryRoot: string,
  platform: NodeJS.Platform,
  fileSystem: BaselineFileSystem,
): Promise<void> {
  await validateParentDirectories(
    lease.parentDirectories,
    resolvedRepositoryRoot,
    platform,
    fileSystem,
  );
  const [handleStats, pathStats, resolvedPath] = await Promise.all([
    lease.handle.stat({ bigint: true }),
    fileSystem.lstat(lease.path),
    fileSystem.realpath(lease.path),
  ]);
  if (
    !handleStats.isFile() ||
    !pathStats.isFile() ||
    !identitiesMatch(lease.identity, fileIdentity(handleStats)) ||
    !identitiesMatch(lease.identity, fileIdentity(pathStats)) ||
    canonicalAbsolutePath(lease.resolvedPath, platform) !==
      canonicalAbsolutePath(resolvedPath, platform)
  ) {
    throw new Error("Reviewed legacy TypeScript file identity changed.");
  }
  requireResolvedPathWithinRepository(resolvedPath, resolvedRepositoryRoot, platform);
}

async function validateLegacyFileLease(
  lease: LegacyFileLease,
  resolvedRepositoryRoot: string,
  platform: NodeJS.Platform,
  fileSystem: BaselineFileSystem,
): Promise<void> {
  await validateLegacyFileIdentity(lease, resolvedRepositoryRoot, platform, fileSystem);
  const digest = await hashFileHandle(lease.handle);
  await validateLegacyFileIdentity(lease, resolvedRepositoryRoot, platform, fileSystem);
  if (digest !== lease.digest) {
    throw new Error("Reviewed legacy TypeScript file content changed.");
  }
}

async function executeTypeScriptDiagnosticVerification(
  options: VerificationOptions,
  fileSystem: BaselineFileSystem,
  leases: LegacyFileLease[],
): Promise<VerificationResult> {
  const baseline = parseBaseline(options.fixture, options.platform);
  const rootResult = await options.runCommand(["git", "rev-parse", "--show-toplevel"], options.cwd);
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

  const resolvedRepositoryRoot = await fileSystem.realpath(repositoryRoot);
  for (const entry of baseline.legacyFileDigests) {
    leases.push(
      await acquireLegacyFileLease(
        entry,
        repositoryRoot,
        resolvedRepositoryRoot,
        options.platform,
        fileSystem,
      ),
    );
  }
  const changedLegacyPaths = leases
    .filter((lease) => lease.digest !== lease.entry.sha256)
    .map((lease) => lease.entry.path);

  const compilerResult = await options.runCommand(baseline.command, repositoryRoot);
  await Promise.all(
    leases.map((lease) =>
      validateLegacyFileLease(lease, resolvedRepositoryRoot, options.platform, fileSystem),
    ),
  );
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
      `TypeScript diagnostic baseline matched: ${baseline.diagnostics.length} diagnostics.`,
      `Reviewed legacy diagnostic files unchanged: ${baseline.legacyFileDigests.length} files.`,
      "Non-baseline TypeScript files clean: 0 diagnostics.",
    ],
    stderr: [],
  };
}

export async function verifyTypeScriptDiagnostics(
  options: VerificationOptions,
): Promise<VerificationResult> {
  const fileSystem = options.fileSystem ?? DEFAULT_BASELINE_FILE_SYSTEM;
  const leases: LegacyFileLease[] = [];
  let result: VerificationResult;
  try {
    result = await executeTypeScriptDiagnosticVerification(options, fileSystem, leases);
  } catch {
    result = failure();
  }
  const closeResults = await Promise.allSettled(leases.map((lease) => lease.handle.close()));
  return closeResults.some((closeResult) => closeResult.status === "rejected") ? failure() : result;
}

async function main(): Promise<void> {
  const result = await verifyTypeScriptDiagnostics({
    fixture: baselineFixture,
    cwd: process.cwd(),
    platform: process.platform,
    runCommand,
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
