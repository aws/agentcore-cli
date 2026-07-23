import { redactTestOutput, sensitiveEnvironmentValues } from '../src/test-utils/test-output-redaction';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

type Mode = 'check' | 'redact';

async function collectFiles(inputPath: string): Promise<string[]> {
  const absolutePath = resolve(inputPath);

  try {
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in test artifacts: ${inputPath}`);
    }
    if (fileStat.isFile()) return [absolutePath];
    if (!fileStat.isDirectory()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => collectFiles(resolve(absolutePath, entry.name))));
  return files.flat();
}

async function main(): Promise<void> {
  const [modeArgument, ...inputPaths] = process.argv.slice(2);
  if ((modeArgument !== '--redact' && modeArgument !== '--check') || inputPaths.length === 0) {
    throw new Error('Usage: tsx scripts/sanitize-test-artifacts.ts <--redact|--check> <path...>');
  }

  const mode = modeArgument.slice(2) as Mode;
  const files = (await Promise.all(inputPaths.map(collectFiles))).flat();
  const secretValues = sensitiveEnvironmentValues();
  const affectedFiles: string[] = [];
  let redactionCount = 0;

  for (const file of files) {
    const original = await readFile(file, 'utf8');
    const result = redactTestOutput(original, secretValues);
    if (result.redactions === 0) continue;

    affectedFiles.push(relative(process.cwd(), file));
    redactionCount += result.redactions;
    if (mode === 'redact') await writeFile(file, result.text, 'utf8');
  }

  if (mode === 'check' && affectedFiles.length > 0) {
    console.error(`Sensitive output detected in ${affectedFiles.length} artifact file(s): ${affectedFiles.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (mode === 'redact') {
    console.log(`Redacted ${redactionCount} sensitive value(s) from ${affectedFiles.length} artifact file(s).`);
  } else {
    console.log(`No sensitive output detected in ${files.length} artifact file(s).`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
