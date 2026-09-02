const HTTP_FETCH = /^npm http fetch [A-Z]+ \d{3} (\S+)/;

/**
 * Rewrites `npm install --loglevel=http` output into lines worth showing in a progress tail. npm
 * prints nothing at all while its stderr is piped, and its HTTP log is the only per-package progress
 * it can be made to emit, so the registry URLs are turned back into package names here. Lines npm
 * already writes for people -- deprecation warnings and the closing summary -- pass through.
 */
export function formatNpmProgressLine(line: string): string | undefined {
  const url = HTTP_FETCH.exec(line)?.[1];
  if (url === undefined) return line;

  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  // Registry API calls name no package. During an install the only one is the audit request.
  if (path.startsWith("/-/")) return "auditing dependencies";

  const [manifestPath = "", tarball] = path.split("/-/");
  const name = packageName(manifestPath);
  if (!name) return undefined;
  if (tarball === undefined) return `resolving ${name}`;
  return `downloading ${name}@${tarballVersion(tarball, name)}`;
}

/**
 * The package name is the tail of the path, since a private registry may serve the same manifests
 * under a prefix (`/artifactory/api/npm/registry/aws-cdk-lib`). A scope arrives either encoded into
 * one segment (`@aws-sdk%2fcore`) or as its own (`@aws-sdk/core`).
 */
function packageName(manifestPath: string): string | undefined {
  const segments = manifestPath.split("/").filter(Boolean).map(decodeSegment);
  const last = segments[segments.length - 1];
  if (last === undefined) return undefined;
  const scope = segments[segments.length - 2];
  return scope?.startsWith("@") ? `${scope}/${last}` : last;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A tarball is named `<unscoped-name>-<version>.tgz`. */
function tarballVersion(tarball: string, name: string): string {
  const base = tarball.replace(/\.tgz$/, "");
  const prefix = `${name.split("/").pop()}-`;
  return base.startsWith(prefix) ? base.slice(prefix.length) : base;
}
