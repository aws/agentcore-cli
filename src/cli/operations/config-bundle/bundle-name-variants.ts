/**
 * Returns all possible API-side names for a config bundle.
 * The API stores bundles with a project-name prefix, but users reference them by local name.
 */
export function getBundleNameVariants(bundleName: string, projectName?: string): string[] {
  return [
    bundleName,
    projectName ? `${projectName}${bundleName}` : undefined,
    projectName ? `${projectName}_${bundleName}` : undefined,
  ].filter((x): x is string => Boolean(x));
}
