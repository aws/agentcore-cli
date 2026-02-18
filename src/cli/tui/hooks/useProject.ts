import { NoProjectError, findConfigRoot } from '../../../lib';
import { dirname } from 'path';
import { useMemo } from 'react';

export interface ProjectContext {
  /** The agentcore/ config directory path */
  configRoot: string;
  /** The project root directory (parent of agentcore/) */
  projectRoot: string;
}

export interface UseProjectResult {
  /** Whether we're in a valid project */
  hasProject: boolean;
  /** Project paths if found, null otherwise */
  project: ProjectContext | null;
  /** Error message if not in project */
  error: string | null;
}

/**
 * Hook to check if we're in a valid AgentCore project.
 * Use this in screens that require being inside a project.
 *
 * @example
 * function CreateScreen() {
 *   const { hasProject, project, error } = useProject();
 *   if (!hasProject) {
 *     return <ErrorScreen message={error} />;
 *   }
 *   // project.configRoot and project.projectRoot are available
 * }
 */
export function useProject(): UseProjectResult {
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- intentionally empty deps; findConfigRoot() result is stable for the process lifetime
  return useMemo(() => {
    const configRoot = findConfigRoot();

    if (!configRoot) {
      return {
        hasProject: false,
        project: null,
        error: new NoProjectError().message,
      };
    }

    return {
      hasProject: true,
      project: {
        configRoot,
        projectRoot: dirname(configRoot),
      },
      error: null,
    };
  }, []);
}
