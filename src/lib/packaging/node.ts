import type { AgentEnvSpec, NodeRuntime, RuntimeVersion } from '../../schema';
import { getArtifactZipName } from '../constants';
import { PackagingError } from '../errors/types';
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
import { build, buildSync } from 'esbuild';
import { cpSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const NODE_RUNTIME_REGEX = /NODE_(\d+)/;

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

const DYNAMIC_REQUIRE_PACKAGES = [
  '@fastify/sse',
  '@fastify/websocket',
  'duplexify',
  'end-of-stream',
  'fastify-plugin',
  'inherits',
  'once',
  'readable-stream',
  'safe-buffer',
  'stream-shift',
  'string_decoder',
  'util-deprecate',
  'wrappy',
  'ws',
];

const DEPS_DIR = '_deps';

function copyDynamicDeps(srcDir: string, stagingDir: string): void {
  const srcNodeModules = join(srcDir, 'node_modules');
  if (!existsSync(srcNodeModules)) return;

  for (const pkg of DYNAMIC_REQUIRE_PACKAGES) {
    const pkgPath = join(srcNodeModules, pkg);
    if (existsSync(pkgPath)) {
      cpSync(pkgPath, join(stagingDir, DEPS_DIR, pkg), { recursive: true });
    }
  }
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
    const cjsBanner =
      'const importMetaUrl = require("url").pathToFileURL(__filename).href;' +
      '(function(){var M=require("module"),p=require("path"),f=require("fs"),d=p.join(__dirname,"_deps"),o=M._resolveFilename;' +
      'M._resolveFilename=function(r,P,i,O){try{return o.call(this,r,P,i,O)}catch(e){' +
      'var dp=p.join(d,r);if(f.existsSync(dp)){var pk=p.join(dp,"package.json");' +
      'if(f.existsSync(pk)){var m=JSON.parse(f.readFileSync(pk,"utf8")).main||"index.js";return p.resolve(dp,m)}' +
      'return p.resolve(dp,"index.js")}throw e}};})();';
    await build({
      entryPoints: [entryFile],
      outfile: join(stagingDir, 'main.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      minify: true,
      target: nodeTarget,
      banner: { js: cjsBanner },
      define: { 'import.meta.url': 'importMetaUrl' },
    });

    writeFileSync(join(stagingDir, 'package.json'), '{"type":"commonjs"}');
    copyDynamicDeps(srcDir, stagingDir);

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    await createZipFromDir(stagingDir, artifactPath);
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
    const cjsBanner =
      'const importMetaUrl = require("url").pathToFileURL(__filename).href;' +
      '(function(){var M=require("module"),p=require("path"),f=require("fs"),d=p.join(__dirname,"_deps"),o=M._resolveFilename;' +
      'M._resolveFilename=function(r,P,i,O){try{return o.call(this,r,P,i,O)}catch(e){' +
      'var dp=p.join(d,r);if(f.existsSync(dp)){var pk=p.join(dp,"package.json");' +
      'if(f.existsSync(pk)){var m=JSON.parse(f.readFileSync(pk,"utf8")).main||"index.js";return p.resolve(dp,m)}' +
      'return p.resolve(dp,"index.js")}throw e}};})();';
    buildSync({
      entryPoints: [entryFile],
      outfile: join(stagingDir, 'main.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      minify: true,
      target: nodeTarget,
      banner: { js: cjsBanner },
      define: { 'import.meta.url': 'importMetaUrl' },
    });

    writeFileSync(join(stagingDir, 'package.json'), '{"type":"commonjs"}');
    copyDynamicDeps(srcDir, stagingDir);

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    createZipFromDirSync(stagingDir, artifactPath);
    const sizeBytes = enforceZipSizeLimitSync(artifactPath);

    return {
      artifactPath,
      sizeBytes,
      stagingPath: stagingDir,
    };
  }
}
