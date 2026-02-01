import { CONFIG_DIR } from '../constants';
import { isWindows } from '../utils/platform';
import { checkSubprocess, checkSubprocessSync, runSubprocess } from '../utils/subprocess';
import { ArtifactSizeError, MissingDependencyError, MissingProjectFileError } from './errors';
import type { PackageOptions } from './types/packaging';
import type { Zippable } from 'fflate';
import { zipSync } from 'fflate';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'path';
import { pipeline } from 'stream/promises';

interface ResolvedPaths {
  projectRoot: string;
  srcDir: string;
  pyprojectPath: string;
  artifactDir: string;
  buildDir: string;
  stagingDir: string;
  artifactsDir: string;
}

const EXCLUDED_ENTRIES = new Set([
  'agentcore',
  '.git',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.DS_Store',
  'node_modules',
]);

export const MAX_ZIP_SIZE_BYTES = 250 * 1024 * 1024;

/**
 * Resolve CodeLocation path relative to repository root
 * @param codeLocation Path from AgentEnvSpec.Runtime.CodeLocation
 * @param configBaseDir Path to agentcore directory
 * @returns Absolute path to code location
 */
export function resolveCodeLocation(codeLocation: string, configBaseDir: string): string {
  if (isAbsolute(codeLocation)) {
    // Absolute paths allowed but discouraged for checked-in configs
    return codeLocation;
  }
  // Resolve relative to repository root (parent of agentcore/)
  // If configBaseDir is /home/user/myproject/agentcore
  // then repository root is /home/user/myproject/
  const repositoryRoot = dirname(configBaseDir);
  return resolve(repositoryRoot, codeLocation);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function findUp(fileName: string, startDir: string): Promise<string | null> {
  let current = resolve(startDir);
  const { root } = parse(current);

  while (true) {
    const candidate = join(current, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }
    if (current === root) {
      return null;
    }
    current = dirname(current);
  }
}

export async function resolveProjectPaths(options: PackageOptions = {}, agentName?: string): Promise<ResolvedPaths> {
  const startDir = options.projectRoot ? resolve(options.projectRoot) : process.cwd();
  const candidatePyproject = options.pyprojectPath
    ? resolve(options.pyprojectPath)
    : await findUp('pyproject.toml', startDir);

  if (!candidatePyproject || !(await pathExists(candidatePyproject))) {
    throw new MissingProjectFileError(options.pyprojectPath ?? join(startDir, 'pyproject.toml'));
  }

  const pyprojectPath = candidatePyproject;

  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : dirname(pyprojectPath);
  const srcDir = resolve(projectRoot, options.srcDir ?? 'src');
  const artifactDir = resolve(options.artifactDir ?? join(projectRoot, CONFIG_DIR));

  // Simplified staging structure: <artifactDir>/<name>/staging
  const name = agentName ?? 'default';
  const buildDir = join(artifactDir, name);
  const stagingDir = join(buildDir, 'staging');
  const artifactsDir = artifactDir;

  return {
    projectRoot,
    srcDir,
    pyprojectPath,
    artifactDir,
    buildDir,
    stagingDir,
    artifactsDir,
  };
}

export async function ensureDirClean(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const stats = await stat(source);
  if (stats.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source);
    for (const entry of entries) {
      if (EXCLUDED_ENTRIES.has(entry)) {
        continue;
      }
      await copyEntry(join(source, entry), join(destination, entry));
    }
    return;
  }

  const readStream = createReadStream(source);
  const writeStream = createWriteStream(destination);
  await pipeline(readStream, writeStream);
}

export async function copySourceTree(srcDir: string, destination: string): Promise<void> {
  if (!(await pathExists(srcDir))) {
    throw new MissingProjectFileError(srcDir);
  }
  await copyEntry(srcDir, destination);
}

export async function ensureBinaryAvailable(binary: string, installHint?: string): Promise<void> {
  const checks: (() => Promise<boolean>)[] = [
    () =>
      isWindows
        ? checkSubprocess('where', [binary])
        : checkSubprocess('sh', ['-c', `command -v ${binary}`], { shell: true }),
    () => checkSubprocess(binary, ['--version']),
    () => checkSubprocess(binary, ['-v']),
    () => (isWindows ? checkSubprocess('cmd', ['/c', 'where', binary]) : checkSubprocess('which', [binary])),
  ];

  for (const check of checks) {
    if (await check()) {
      return;
    }
  }

  throw new MissingDependencyError(binary, installHint);
}

export async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  await runSubprocess(command, args, { cwd });
}

export async function createZipFromDir(sourceDir: string, outputZip: string): Promise<void> {
  await rm(outputZip, { force: true });
  await mkdir(dirname(outputZip), { recursive: true });

  const files = await collectFiles(sourceDir);
  const zipped = zipSync(files);
  await writeFile(outputZip, zipped);
}

async function collectFiles(directory: string, basePath = ''): Promise<Zippable> {
  const result: Zippable = {};
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_ENTRIES.has(entry.name)) continue;

    const fullPath = join(directory, entry.name);
    const zipPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      Object.assign(result, await collectFiles(fullPath, zipPath));
    } else if (entry.isFile()) {
      result[zipPath] = [await readFile(fullPath), { level: 6 }];
    }
  }
  return result;
}

export async function enforceZipSizeLimit(zipPath: string): Promise<number> {
  const { size } = await stat(zipPath);
  if (size > MAX_ZIP_SIZE_BYTES) {
    throw new ArtifactSizeError(MAX_ZIP_SIZE_BYTES, size);
  }
  return size;
}

function pathExistsSync(path: string): boolean {
  return existsSync(path);
}

function findUpSync(fileName: string, startDir: string): string | null {
  let current = resolve(startDir);
  const { root } = parse(current);

  while (true) {
    const candidate = join(current, fileName);
    if (pathExistsSync(candidate)) {
      return candidate;
    }
    if (current === root) {
      return null;
    }
    current = dirname(current);
  }
}

export function resolveProjectPathsSync(options: PackageOptions = {}, agentName?: string): ResolvedPaths {
  const startDir = options.projectRoot ? resolve(options.projectRoot) : process.cwd();
  const candidatePyproject = options.pyprojectPath
    ? resolve(options.pyprojectPath)
    : findUpSync('pyproject.toml', startDir);

  if (!candidatePyproject || !pathExistsSync(candidatePyproject)) {
    throw new MissingProjectFileError(options.pyprojectPath ?? join(startDir, 'pyproject.toml'));
  }

  const pyprojectPath = candidatePyproject;
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : dirname(pyprojectPath);
  const srcDir = resolve(projectRoot, options.srcDir ?? 'src');
  const artifactDir = resolve(options.artifactDir ?? join(projectRoot, CONFIG_DIR));

  // Simplified staging structure: <artifactDir>/<name>/staging
  const name = agentName ?? 'default';
  const buildDir = join(artifactDir, name);
  const stagingDir = join(buildDir, 'staging');
  const artifactsDir = artifactDir;

  return {
    projectRoot,
    srcDir,
    pyprojectPath,
    artifactDir,
    buildDir,
    stagingDir,
    artifactsDir,
  };
}

export function ensureDirCleanSync(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function copyEntrySync(source: string, destination: string): void {
  const stats = statSync(source);
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    const entries = readdirSync(source);
    for (const entry of entries) {
      if (EXCLUDED_ENTRIES.has(entry)) {
        continue;
      }
      copyEntrySync(join(source, entry), join(destination, entry));
    }
    return;
  }

  copyFileSync(source, destination);
}

export function copySourceTreeSync(srcDir: string, destination: string): void {
  if (!pathExistsSync(srcDir)) {
    throw new MissingProjectFileError(srcDir);
  }
  copyEntrySync(srcDir, destination);
}

export function ensureBinaryAvailableSync(binary: string, installHint?: string): void {
  const checks: (() => boolean)[] = [
    () =>
      isWindows
        ? checkSubprocessSync('where', [binary])
        : checkSubprocessSync('sh', ['-c', `command -v ${binary}`], { shell: true }),
    () => checkSubprocessSync(binary, ['--version']),
    () => checkSubprocessSync(binary, ['-v']),
    () => (isWindows ? checkSubprocessSync('cmd', ['/c', 'where', binary]) : checkSubprocessSync('which', [binary])),
  ];

  for (const check of checks) {
    if (check()) {
      return;
    }
  }

  throw new MissingDependencyError(binary, installHint);
}

function collectFilesSync(directory: string, basePath = ''): Zippable {
  const result: Zippable = {};
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_ENTRIES.has(entry.name)) continue;

    const fullPath = join(directory, entry.name);
    const zipPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      Object.assign(result, collectFilesSync(fullPath, zipPath));
    } else if (entry.isFile()) {
      result[zipPath] = [readFileSync(fullPath), { level: 6 }];
    }
  }
  return result;
}

export function createZipFromDirSync(sourceDir: string, outputZip: string): void {
  rmSync(outputZip, { force: true });
  mkdirSync(dirname(outputZip), { recursive: true });

  const files = collectFilesSync(sourceDir);
  const zipped = zipSync(files);
  writeFileSync(outputZip, zipped);
}

export function enforceZipSizeLimitSync(zipPath: string): number {
  const { size } = statSync(zipPath);
  if (size > MAX_ZIP_SIZE_BYTES) {
    throw new ArtifactSizeError(MAX_ZIP_SIZE_BYTES, size);
  }
  return size;
}

/**
 * Generates a Linux-compatible shell script for a Python console entry point.
 * This is needed when packaging on Windows for Linux targets, as uv generates
 * .exe files based on the host OS rather than the target platform.
 */
function generateLinuxConsoleScript(modulePath: string, funcName: string): string {
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re
import sys
from ${modulePath} import ${funcName}
if __name__ == '__main__':
    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])
    sys.exit(${funcName}())
`;
}

/**
 * Known console script entry points that need to be converted from Windows .exe
 * to Linux shell scripts when cross-compiling.
 * Format: { 'script-name': ['module.path', 'function_name'] }
 */
const KNOWN_CONSOLE_SCRIPTS: Record<string, [string, string]> = {
  'opentelemetry-instrument': ['opentelemetry.instrumentation.auto_instrumentation', 'run'],
  'opentelemetry-bootstrap': ['opentelemetry.instrumentation.bootstrap', 'run'],
};

/**
 * Converts Windows .exe console scripts to Linux-compatible shell scripts.
 * This is necessary when packaging Python dependencies on Windows for deployment
 * to Linux-based AWS runtimes.
 *
 * @param stagingDir The directory containing installed Python packages
 */
export async function convertWindowsScriptsToLinux(stagingDir: string): Promise<void> {
  if (!isWindows) {
    return; // Only needed when building on Windows
  }

  const binDir = join(stagingDir, 'bin');
  if (!(await pathExists(binDir))) {
    return;
  }

  const entries = await readdir(binDir);

  for (const entry of entries) {
    if (!entry.endsWith('.exe')) {
      continue;
    }

    const scriptName = entry.slice(0, -4); // Remove .exe extension
    const entryPoint = KNOWN_CONSOLE_SCRIPTS[scriptName];

    if (entryPoint) {
      const [modulePath, funcName] = entryPoint;
      const exePath = join(binDir, entry);
      const scriptPath = join(binDir, scriptName);

      // Remove the Windows .exe file
      await unlink(exePath);

      // Create Linux-compatible shell script
      const scriptContent = generateLinuxConsoleScript(modulePath, funcName);
      await writeFile(scriptPath, scriptContent, { mode: 0o755 });
    }
  }
}

/**
 * Synchronous version of convertWindowsScriptsToLinux.
 */
export function convertWindowsScriptsToLinuxSync(stagingDir: string): void {
  if (!isWindows) {
    return; // Only needed when building on Windows
  }

  const binDir = join(stagingDir, 'bin');
  if (!pathExistsSync(binDir)) {
    return;
  }

  const entries = readdirSync(binDir);

  for (const entry of entries) {
    if (!entry.endsWith('.exe')) {
      continue;
    }

    const scriptName = entry.slice(0, -4); // Remove .exe extension
    const entryPoint = KNOWN_CONSOLE_SCRIPTS[scriptName];

    if (entryPoint) {
      const [modulePath, funcName] = entryPoint;
      const exePath = join(binDir, entry);
      const scriptPath = join(binDir, scriptName);

      // Remove the Windows .exe file
      unlinkSync(exePath);

      // Create Linux-compatible shell script
      const scriptContent = generateLinuxConsoleScript(modulePath, funcName);
      writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    }
  }
}
