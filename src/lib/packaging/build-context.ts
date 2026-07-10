import type { AgentEnvSpec } from '../../schema';
import { getDockerfilePath } from '../constants';
import { resolveCodeLocation } from './helpers';

/** Resolved Docker build context and Dockerfile path for a Container agent. */
export interface ResolvedBuildContext {
  /** Absolute path to the Docker build context (`buildContextPath` when set, else `codeLocation`). */
  buildContext: string;
  /** Absolute path to the Dockerfile, resolved against the build context. */
  dockerfilePath: string;
}

/**
 * Resolve the Docker build context + Dockerfile path for a Container agent — the single source of
 * truth shared by `package` (ContainerPackager), `deploy` preflight, and `dev`.
 *
 * The context is `buildContextPath` when set, otherwise `codeLocation`, resolved via
 * `resolveCodeLocation` (the same resolver the deploy-side `ContainerSourceAsset` uses to upload it),
 * and the Dockerfile is resolved against that context (matching the CodeBuild buildspec's `-f`).
 * Collapsing this into one function keeps local `dev`/`package` and `deploy` from ever resolving the
 * context differently — a divergence would otherwise let a config build from one directory locally and
 * a different one on deploy.
 */
export function resolveBuildContext(
  spec: Pick<AgentEnvSpec, 'codeLocation' | 'buildContextPath' | 'dockerfile'>,
  baseDir: string
): ResolvedBuildContext {
  const buildContext = resolveCodeLocation(spec.buildContextPath ?? spec.codeLocation, baseDir);
  return { buildContext, dockerfilePath: getDockerfilePath(buildContext, spec.dockerfile) };
}
