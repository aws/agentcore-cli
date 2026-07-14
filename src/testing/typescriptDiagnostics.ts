import { posix } from "node:path";

export type TypeScriptDiagnostic = Readonly<{
  path: string;
  line: number;
  column: number;
  code: `TS${number}`;
  message: string;
}>;

export type DiagnosticComparison =
  | Readonly<{ kind: "matched" }>
  | Readonly<{
      kind: "mismatched";
      missing: readonly TypeScriptDiagnostic[];
      unexpected: readonly TypeScriptDiagnostic[];
    }>;

const DIAGNOSTIC_PATTERN = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const UNSUPPORTED_DIAGNOSTIC_PATTERN = /(?:^|\s)error TS\d+:/;

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

function sortDiagnostics(
  diagnostics: readonly TypeScriptDiagnostic[],
): readonly TypeScriptDiagnostic[] {
  return [...diagnostics].sort(compareDiagnosticTuples);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function normalizeRoot(root: string): string {
  const normalized = posix.normalize(root.replaceAll("\\", "/"));
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

function isWithinRoot(absolutePath: string, root: string): boolean {
  const caseInsensitive = isWindowsAbsolutePath(root);
  const comparablePath = caseInsensitive ? absolutePath.toLowerCase() : absolutePath;
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const prefix = comparableRoot.endsWith("/") ? comparableRoot : `${comparableRoot}/`;
  return comparablePath.startsWith(prefix);
}

function normalizeRepositoryPath(
  value: string,
  invalidPathMessage: string,
  repositoryRoot = process.cwd(),
): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(invalidPathMessage);
  }

  const slashPath = value.replaceAll("\\", "/");
  const root = normalizeRoot(repositoryRoot);
  const absolute = slashPath.startsWith("/") || isWindowsAbsolutePath(slashPath);
  let relativePath = slashPath;

  if (absolute) {
    const normalizedAbsolute = posix.normalize(slashPath);
    const rootIsWindows = isWindowsAbsolutePath(root);
    const pathIsWindows = isWindowsAbsolutePath(normalizedAbsolute);
    if (rootIsWindows !== pathIsWindows || !isWithinRoot(normalizedAbsolute, root)) {
      throw new Error(invalidPathMessage);
    }
    relativePath = normalizedAbsolute.slice(root.endsWith("/") ? root.length : root.length + 1);
  }

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

export function parseDiagnostics(stderr: string): readonly TypeScriptDiagnostic[] {
  const diagnostics: TypeScriptDiagnostic[] = [];
  let current: TypeScriptDiagnostic | undefined;

  const finishCurrent = (): void => {
    if (current !== undefined) {
      diagnostics.push(current);
      current = undefined;
    }
  };

  for (const outputLine of stderr.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const match = DIAGNOSTIC_PATTERN.exec(outputLine);
    if (match !== null) {
      finishCurrent();
      const [, diagnosticPath, line, column, code, message] = match;
      if (
        diagnosticPath === undefined ||
        line === undefined ||
        column === undefined ||
        code === undefined ||
        message === undefined
      ) {
        throw new Error("Unsupported TypeScript diagnostic format.");
      }
      const lineNumber = Number(line);
      const columnNumber = Number(column);
      if (
        !Number.isSafeInteger(lineNumber) ||
        lineNumber < 1 ||
        !Number.isSafeInteger(columnNumber) ||
        columnNumber < 1
      ) {
        throw new Error("Unsupported TypeScript diagnostic format.");
      }
      current = {
        path: normalizeRepositoryPath(diagnosticPath, "Diagnostic path is outside the repository."),
        line: lineNumber,
        column: columnNumber,
        code: code as `TS${number}`,
        message: message.trim(),
      };
      continue;
    }

    if (current !== undefined && /^[ \t]/.test(outputLine)) {
      current = {
        ...current,
        message: `${current.message}\n${outputLine.trim()}`,
      };
      continue;
    }

    finishCurrent();
    if (UNSUPPORTED_DIAGNOSTIC_PATTERN.test(outputLine)) {
      throw new Error("Unsupported TypeScript diagnostic format.");
    }
  }

  finishCurrent();
  return sortDiagnostics(diagnostics);
}

export function compareDiagnostics(
  expected: readonly TypeScriptDiagnostic[],
  actual: readonly TypeScriptDiagnostic[],
): DiagnosticComparison {
  const sortedExpected = sortDiagnostics(expected);
  const sortedActual = sortDiagnostics(actual);
  const missing: TypeScriptDiagnostic[] = [];
  const unexpected: TypeScriptDiagnostic[] = [];
  let expectedIndex = 0;
  let actualIndex = 0;

  while (expectedIndex < sortedExpected.length && actualIndex < sortedActual.length) {
    const expectedDiagnostic = sortedExpected[expectedIndex];
    const actualDiagnostic = sortedActual[actualIndex];
    if (expectedDiagnostic === undefined || actualDiagnostic === undefined) {
      throw new Error("Diagnostic comparison failed.");
    }
    const comparison = compareDiagnosticTuples(expectedDiagnostic, actualDiagnostic);
    if (comparison === 0) {
      expectedIndex += 1;
      actualIndex += 1;
    } else if (comparison < 0) {
      missing.push(expectedDiagnostic);
      expectedIndex += 1;
    } else {
      unexpected.push(actualDiagnostic);
      actualIndex += 1;
    }
  }

  missing.push(...sortedExpected.slice(expectedIndex));
  unexpected.push(...sortedActual.slice(actualIndex));
  if (missing.length === 0 && unexpected.length === 0) {
    return { kind: "matched" };
  }
  return { kind: "mismatched", missing, unexpected };
}
