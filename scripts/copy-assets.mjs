import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, '..', 'src', 'assets');
const destDir = path.join(__dirname, '..', 'dist', 'assets');

/**
 * Recursively copy directory contents, excluding specified files at root level only
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @param {string[]} excludeAtRoot - Files to exclude only at the root level (e.g., 'AGENTS.md')
 * @param {boolean} isRoot - Whether this is the root level call
 */
function copyDir(src, dest, excludeAtRoot = [], isRoot = true) {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip excluded files only at root level
    if (isRoot && excludeAtRoot.includes(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, excludeAtRoot, false);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  console.log('Copying assets...');
  copyDir(srcDir, destDir, ['AGENTS.md']);
  console.log('Assets copied successfully!');
} catch (error) {
  console.error('Error copying assets:', error);
  process.exit(1);
}
