/**
 * Snapshot tests for the assets directory.
 *
 * These tests ensure that template files vended to users don't change unexpectedly.
 * If you intentionally change an asset file, update snapshots with:
 *
 *   npm run test:snapshots:update
 *
 * See docs/TESTING.md for more information.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ASSETS_DIR = path.resolve(__dirname, '..');

/**
 * Recursively get all files in a directory
 */
function getAllFiles(dir: string, baseDir: string = dir): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip __tests__ directory to avoid circular snapshots
      if (entry.name === '__tests__' || entry.name === '__snapshots__') {
        continue;
      }
      files.push(...getAllFiles(fullPath, baseDir));
    } else {
      // Get relative path from assets dir for cleaner snapshot names
      const relativePath = path.relative(baseDir, fullPath);
      files.push(relativePath);
    }
  }

  return files.sort();
}

/**
 * Read file content, handling binary files gracefully
 */
function readFileContent(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content;
}

describe('Assets Directory Snapshots', () => {
  const assetFiles = getAllFiles(ASSETS_DIR);

  it('should have asset files to test', () => {
    expect(assetFiles.length).toBeGreaterThan(0);
  });

  describe('File listing', () => {
    it('should match the expected file structure', () => {
      expect(assetFiles).toMatchSnapshot('asset-file-listing');
    });
  });

  describe('CDK assets', () => {
    const cdkFiles = assetFiles.filter(f => f.startsWith('cdk/'));

    it.each(cdkFiles)('cdk/%s should match snapshot', file => {
      const content = readFileContent(path.join(ASSETS_DIR, file));
      expect(content).toMatchSnapshot();
    });
  });

  describe('Python framework assets', () => {
    const pythonFiles = assetFiles.filter(f => f.startsWith('python/'));

    it.each(pythonFiles)('python/%s should match snapshot', file => {
      const content = readFileContent(path.join(ASSETS_DIR, file));
      expect(content).toMatchSnapshot();
    });
  });

  describe('MCP assets', () => {
    const mcpFiles = assetFiles.filter(f => f.startsWith('mcp/'));

    it.each(mcpFiles)('mcp/%s should match snapshot', file => {
      const content = readFileContent(path.join(ASSETS_DIR, file));
      expect(content).toMatchSnapshot();
    });
  });

  describe('Static assets', () => {
    const staticFiles = assetFiles.filter(f => f.startsWith('static/'));

    if (staticFiles.length > 0) {
      it.each(staticFiles)('static/%s should match snapshot', file => {
        const content = readFileContent(path.join(ASSETS_DIR, file));
        expect(content).toMatchSnapshot();
      });
    } else {
      it('static directory is empty or does not exist', () => {
        // Static assets may not exist
        expect(true).toBe(true);
      });
    }
  });

  describe('TypeScript assets', () => {
    const tsFiles = assetFiles.filter(f => f.startsWith('typescript/'));

    if (tsFiles.length > 0) {
      it.each(tsFiles)('typescript/%s should match snapshot', file => {
        const content = readFileContent(path.join(ASSETS_DIR, file));
        expect(content).toMatchSnapshot();
      });
    } else {
      it('typescript directory is empty or contains only placeholder files', () => {
        // TypeScript assets may not exist yet
        expect(true).toBe(true);
      });
    }
  });

  describe('Root-level assets', () => {
    const rootFiles = assetFiles.filter(
      f =>
        !f.includes('/') ||
        (f.startsWith('agents/') &&
          !f.startsWith('cdk/') &&
          !f.startsWith('python/') &&
          !f.startsWith('mcp/') &&
          !f.startsWith('static/') &&
          !f.startsWith('typescript/'))
    );

    it.each(rootFiles)('%s should match snapshot', file => {
      const content = readFileContent(path.join(ASSETS_DIR, file));
      expect(content).toMatchSnapshot();
    });
  });
});
