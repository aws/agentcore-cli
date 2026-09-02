import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Layout } from "../../components/Layout";
import { Spinner } from "../../components/ui/spinner";
import { darkTheme } from "../../components/ui/_core.js";
import { projectNotFoundMessage } from "../../middleware/withProject";
import type { Core } from "../types";
import type { Project } from "./types";

const theme = darkTheme;

export interface UseProjectResult {
  project?: Project;
  error?: string;
}

// useProject resolves the project enclosing the working directory for a TUI
// screen. Screens need their own resolution because withProject wraps `handle`
// only: middleware runs when a command executes, and navigating between TUI
// screens never executes one, so ProjectKey is set only when the launching
// command happened to be a project command. When it was, pass it as `seed` and
// no resolution happens. The not-found guidance is withProject's own.
export function useProject(core: Core, seed?: Project): UseProjectResult {
  const [project, setProject] = useState<Project | undefined>(seed);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (project !== undefined) return;
    let active = true;
    const from = process.cwd();
    void core.projectManager
      .resolve({ filePath: from })
      .then((resolved) => {
        if (!active) return;
        if (!resolved) {
          setError(projectNotFoundMessage(from));
          return;
        }
        setProject(resolved);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [core.projectManager, project]);

  return { project, error };
}

export interface ProjectGateProps {
  core: Core;
  breadcrumb: string[];
  description?: string;
  // seed is the project already pinned on the launch context, when the command
  // that opened the TUI was itself a project command.
  seed?: Project;
  // children receives the resolved project and returns the screen. It must
  // return an element rather than call hooks itself — the gate renders a
  // spinner on the first paint, so a hook called here would change order.
  children: (project: Project) => React.ReactElement;
}

// ProjectGate resolves the project before rendering a project screen, showing
// the same not-found guidance the CLI prints when there is none.
export function ProjectGate({ core, breadcrumb, description, seed, children }: ProjectGateProps) {
  const { project, error } = useProject(core, seed);

  if (project !== undefined) return children(project);

  return (
    <Layout
      breadcrumb={breadcrumb}
      description={description}
      keyHints={[{ key: "ctl+c", label: "quit" }]}
    >
      <Box paddingX={1}>
        {error === undefined ? (
          <Spinner label="loading project…" />
        ) : (
          <Text color={theme.colors.error}>✗ {error}</Text>
        )}
      </Box>
    </Layout>
  );
}
