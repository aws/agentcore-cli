/**
 * Returns all possible API-side names for a config bundle.
 * The API stores bundles with a project-name prefix, but users reference them by local name.
 * Pass several project names to also match targets that use a resourceNameSuffix
 * (prefix `${projectName}${suffix}`).
 */
export function getBundleNameVariants(bundleName: string, projectNames?: string | readonly string[]): string[] {
  const prefixes = [...new Set(typeof projectNames === 'string' ? [projectNames] : (projectNames ?? []))].filter(
    Boolean
  );
  return [
    bundleName,
    ...prefixes.flatMap(projectName => [`${projectName}${bundleName}`, `${projectName}_${bundleName}`]),
  ].filter((x): x is string => Boolean(x));
}
