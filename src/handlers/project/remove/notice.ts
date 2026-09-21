export function getRuntimeCodeKeptNotice(runtimeName: string, sourcePath: string): string {
  return `Runtime '${runtimeName}' has been removed, but the source code is still in ${sourcePath}.`;
}
