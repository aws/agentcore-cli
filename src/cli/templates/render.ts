import Handlebars from 'handlebars';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Register custom Handlebars helpers
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
Handlebars.registerHelper('includes', (array: unknown[], value: unknown) => {
  if (!Array.isArray(array)) return false;
  return array.includes(value);
});

/**
 * Renames template files to their actual names.
 * e.g., "gitignore.template" -> ".gitignore"
 */
function resolveTemplateName(filename: string): string {
  if (filename === 'gitignore.template') return '.gitignore';
  if (filename === 'npmignore.template') return '.npmignore';
  if (filename === 'dockerignore.template') return '.dockerignore';
  return filename;
}

/**
 * Recursively copies a directory from src to dest.
 * Handles template file renaming (e.g., gitignore.template -> .gitignore).
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destName = resolveTemplateName(entry.name);
    const destPath = path.join(dest, destName);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Recursively copies a directory, rendering Handlebars templates.
 */
export async function copyAndRenderDir<T extends object>(src: string, dest: string, data: T): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destName = resolveTemplateName(entry.name);
    const destPath = path.join(dest, destName);

    if (entry.isDirectory()) {
      await copyAndRenderDir(srcPath, destPath, data);
    } else {
      const content = await fs.readFile(srcPath, 'utf-8');
      const template = Handlebars.compile(content);
      const rendered = template(data);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, rendered, 'utf-8');
    }
  }
}
