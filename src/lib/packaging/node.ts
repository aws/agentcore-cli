import type { AgentEnvSpec, NodeRuntime, RuntimeVersion } from '../../schema';
import { getArtifactZipName } from '../constants';
import { PackagingError } from '../errors/types';
import { DYNAMIC_REQUIRE_PACKAGES, NODE_CJS_BANNER, NODE_RUNTIME_REGEX } from './constants';
import {
  createZipFromDir,
  createZipFromDirSync,
  enforceZipSizeLimit,
  enforceZipSizeLimitSync,
  ensureDirClean,
  ensureDirCleanSync,
  isNodeRuntime,
  resolveNodeProjectPaths,
  resolveNodeProjectPathsSync,
} from './helpers';
import type { ArtifactResult, CodeZipPackager, PackageOptions, RuntimePackager } from './types/packaging';
import type { Metafile } from 'esbuild';
import { build, buildSync } from 'esbuild';
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { createRequire, isBuiltin } from 'module';
import { basename, join } from 'path';

/**
 * Type guard to check if runtime version is a Node runtime
 */
function isNodeRuntimeVersion(version: RuntimeVersion): version is NodeRuntime {
  return isNodeRuntime(version);
}

/**
 * Extracts Node version from runtime constant.
 * Example: NODE_20 -> "20" (for use with node version checks)
 */
export function extractNodeVersion(runtime: NodeRuntime): string {
  const match = NODE_RUNTIME_REGEX.exec(runtime);
  if (!match) {
    throw new PackagingError(`Unsupported Node runtime value: ${runtime}`);
  }
  const [, major] = match;
  if (!major) {
    throw new PackagingError(`Invalid Node runtime value: ${runtime}`);
  }
  return major;
}

interface DependencyManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function resolvePackageDirectory(name: string, fromDir: string): string | undefined {
  const resolver = createRequire(join(fromDir, 'package.json'));
  // Search package directories, not exported entry points: exports can hide package.json
  // or expose only subpaths. realpath also resolves pnpm's workspace/store links.
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return undefined;
}

function copyDynamicDeps(srcDir: string, stagingDir: string, metafile?: Metafile): void {
  const roots = new Set(DYNAMIC_REQUIRE_PACKAGES);
  for (const output of Object.values(metafile?.outputs ?? {})) {
    for (const imported of output.imports) {
      if (!imported.external || isBuiltin(imported.path) || imported.path.startsWith('.')) continue;
      roots.add(
        imported.path
          .split('/')
          .slice(0, imported.path.startsWith('@') ? 2 : 1)
          .join('/')
      );
    }
  }

  const copyPackage = (
    name: string,
    fromDir: string,
    destinationModules: string,
    ancestors: Map<string, string>,
    required = false
  ): void => {
    if (isBuiltin(name)) return;
    const source = resolvePackageDirectory(name, fromDir);
    if (!source) {
      if (required) throw new PackagingError('Cannot package dependency "' + name + '" required by ' + fromDir);
      return; // Optional packages and dynamic-require fallbacks may not be installed.
    }
    if (ancestors.get(name) === source) return; // Node resolves cycles through ancestor node_modules.
    const destination = join(destinationModules, name);
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => {
        const entry = basename(path);
        return entry !== 'node_modules' && entry !== '.git' && entry !== '.env' && !entry.startsWith('.env.');
      },
    });
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as DependencyManifest;
    const chain = new Map(ancestors).set(name, source);
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const dependency of dependencies) {
      copyPackage(
        dependency,
        source,
        join(destination, 'node_modules'),
        chain,
        dependency in (manifest.dependencies ?? {}) && !(dependency in (manifest.optionalDependencies ?? {}))
      );
    }
  };
  for (const name of roots) copyPackage(name, srcDir, join(stagingDir, 'node_modules'), new Map());
}

/**
 * Async Node/TypeScript packager for CLI usage.
 * Bundles TypeScript source into a single JS file using esbuild.
 */
export class NodeCodeZipPackager implements RuntimePackager {
  async pack(spec: AgentEnvSpec, options: PackageOptions = {}): Promise<ArtifactResult> {
    if (spec.build !== 'CodeZip') {
      throw new PackagingError('Node packager only supports CodeZip build type.');
    }

    if (!isNodeRuntimeVersion(spec.runtimeVersion!)) {
      throw new PackagingError(`Node packager only supports Node runtimes. Received: ${spec.runtimeVersion}`);
    }

    const agentName = options.agentName ?? spec.name;
    const { srcDir, stagingDir, artifactsDir } = await resolveNodeProjectPaths(options, agentName);

    await ensureDirClean(stagingDir);

    const entryFile = join(srcDir, 'main.ts');
    const runtimeVersion = spec.runtimeVersion;
    const nodeTarget = `node${extractNodeVersion(runtimeVersion)}`;
    const result = await build({
      entryPoints: [entryFile],
      outfile: join(stagingDir, 'main.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      minify: true,
      target: nodeTarget,
      metafile: true,
      banner: { js: NODE_CJS_BANNER },
      define: { 'import.meta.url': 'importMetaUrl' },
    });

    writeFileSync(join(stagingDir, 'package.json'), '{"type":"commonjs"}');
    copyDynamicDeps(srcDir, stagingDir, result.metafile);

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    await createZipFromDir(stagingDir, artifactPath, true);
    const sizeBytes = await enforceZipSizeLimit(artifactPath);

    return {
      artifactPath,
      sizeBytes,
      stagingPath: stagingDir,
    };
  }
}

/**
 * Sync Node/TypeScript packager for CDK bundling.
 * Bundles TypeScript source into a single JS file using esbuild.
 */
export class NodeCodeZipPackagerSync implements CodeZipPackager {
  packCodeZip(config: AgentEnvSpec, options: PackageOptions = {}): ArtifactResult {
    const runtimeVersion = config.runtimeVersion ?? 'NODE_20';

    if (!isNodeRuntimeVersion(runtimeVersion)) {
      throw new PackagingError(`Node packager only supports Node runtimes. Received: ${runtimeVersion}`);
    }

    const agentName = options.agentName ?? config.name ?? 'asset';
    const { srcDir, stagingDir, artifactsDir } = resolveNodeProjectPathsSync(options, agentName);

    ensureDirCleanSync(stagingDir);

    const entryFile = join(srcDir, 'main.ts');
    const nodeTarget = `node${extractNodeVersion(runtimeVersion)}`;
    const result = buildSync({
      entryPoints: [entryFile],
      outfile: join(stagingDir, 'main.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      minify: true,
      target: nodeTarget,
      metafile: true,
      banner: { js: NODE_CJS_BANNER },
      define: { 'import.meta.url': 'importMetaUrl' },
    });

    writeFileSync(join(stagingDir, 'package.json'), '{"type":"commonjs"}');
    copyDynamicDeps(srcDir, stagingDir, result.metafile);

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    createZipFromDirSync(stagingDir, artifactPath, true);
    const sizeBytes = enforceZipSizeLimitSync(artifactPath);

    return {
      artifactPath,
      sizeBytes,
      stagingPath: stagingDir,
    };
  }
}
