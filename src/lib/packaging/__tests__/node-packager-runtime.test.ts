import type { AgentEnvSpec } from '../../../schema';
import { NodeCodeZipPackager, NodeCodeZipPackagerSync } from '../node';
import { execFileSync } from 'child_process';
import { unzipSync } from 'fflate';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirs: string[] = [];

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentcore-node-package-'));
  temporaryDirs.push(root);
  write(join(root, 'package.json'), '{"name":"workspace","private":true}');
  write(join(root, 'app/main.ts'), 'const name = "@fastify/sse/detail"; console.log(require(name));');
  const pkg = join(root, 'node_modules/.pnpm/sse/node_modules/@fastify/sse');
  write(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@fastify/sse',
      exports: { './detail': './detail.js' },
      dependencies: { 'test-child': '1.0.0' },
      optionalDependencies: { 'missing-optional': '1.0.0' },
    })
  );
  write(join(pkg, 'detail.js'), 'module.exports = require("test-child");');
  write(join(pkg, '.env.local'), 'DO_NOT_PACKAGE=secret');
  const child = join(root, 'node_modules/.pnpm/sse/node_modules/test-child');
  write(join(child, 'package.json'), '{"name":"test-child","main":"index.js"}');
  write(join(child, 'index.js'), 'module.exports = "workspace dependency loaded";');
  mkdirSync(join(root, 'node_modules/@fastify'), { recursive: true });
  symlinkSync(pkg, join(root, 'node_modules/@fastify/sse'), 'junction');
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.each(['async', 'sync'] as const)('Node packager runtime (%s)', mode => {
  async function pack(root: string) {
    const spec = { name: 'test-agent', build: 'CodeZip', runtimeVersion: 'NODE_22' } as AgentEnvSpec;
    const options = { projectRoot: root, srcDir: 'app' };
    return mode === 'async'
      ? new NodeCodeZipPackager().pack(spec, options)
      : new NodeCodeZipPackagerSync().packCodeZip(spec, options);
  }

  it('runs an isolated ZIP with workspace symlinks, package exports and transitive dependencies', async () => {
    const root = fixture();
    const result = await pack(root);
    const files = unzipSync(readFileSync(result.artifactPath));
    expect(Object.keys(files).some(path => path.endsWith('/test-child/index.js'))).toBe(true);
    expect(Object.keys(files).some(path => path.includes('.env'))).toBe(false);
    const extracted = mkdtempSync(join(tmpdir(), 'agentcore-node-extracted-'));
    temporaryDirs.push(extracted);
    for (const [name, bytes] of Object.entries(files)) write(join(extracted, name), Buffer.from(bytes).toString());
    // The extracted artifact is outside the workspace; no source node_modules can help it resolve.
    expect(
      execFileSync(process.execPath, [join(extracted, 'main.js')], { encoding: 'utf8', env: { NODE_PATH: '' } })
    ).toContain('workspace dependency loaded');
  });

  it('fails packaging rather than silently dropping a required transitive dependency', async () => {
    const root = fixture();
    rmSync(join(root, 'node_modules/.pnpm/sse/node_modules/test-child'), { recursive: true });
    await expect(pack(root)).rejects.toThrow(/test-child/);
  });

  it('terminates dependency cycles and preserves conflicting nested versions', async () => {
    const root = fixture();
    const child = join(root, 'node_modules/.pnpm/sse/node_modules/test-child');
    write(
      join(child, 'package.json'),
      '{"name":"test-child","main":"index.js","dependencies":{"@fastify/sse":"1.0.0"}}'
    );
    const second = join(root, 'node_modules/fastify-plugin');
    write(join(second, 'package.json'), '{"name":"fastify-plugin","dependencies":{"test-child":"2.0.0"}}');
    write(join(second, 'index.js'), 'module.exports = require("test-child");');
    write(join(second, 'node_modules/test-child/package.json'), '{"name":"test-child","main":"index.js"}');
    write(join(second, 'node_modules/test-child/index.js'), 'module.exports = "second version";');
    write(
      join(root, 'app/main.ts'),
      'const a = "@fastify/sse/detail", b = "fastify-plugin"; console.log(require(a), require(b));'
    );
    const result = await pack(root);
    const extracted = mkdtempSync(join(tmpdir(), 'agentcore-node-cycle-'));
    temporaryDirs.push(extracted);
    for (const [name, bytes] of Object.entries(unzipSync(readFileSync(result.artifactPath)))) {
      write(join(extracted, name), Buffer.from(bytes).toString());
    }
    expect(
      execFileSync(process.execPath, [join(extracted, 'main.js')], { encoding: 'utf8', env: { NODE_PATH: '' } })
    ).toContain('workspace dependency loaded second version');
  });
});
