export function getSourceCodeRemainsNotice(resourceName: string, sourcePath: string): string {
  return `Resource '${resourceName}' has been removed, but the source code is still in ${sourcePath}.`;
}
