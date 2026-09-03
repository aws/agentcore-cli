import React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Box, Text, useInput } from "ink";
import { Layout } from "../../components/Layout";
import { Spinner } from "../../components/ui/spinner";
import { darkTheme } from "../../components/ui/_core.js";
import { ProjectStateError } from "../../errors/errors";
import { projectNotFoundMessage } from "../../middleware/withProject";
import type { Core } from "../types";
import type { Project } from "./types";

const theme = darkTheme;

// useProject resolves the project enclosing the cwd for a TUI screen. Screens
// resolve it themselves because withProject wraps `handle` only, and navigating
// between screens never executes a command — ProjectKey is set only when the
// launching command was a project command, in which case pass it as `seed`.
export function useProject(core: Core, seed?: Project): UseQueryResult<Project> {
  const from = process.cwd();
  return useQuery({
    queryKey: ["project", from],
    queryFn: async () => {
      const project = await core.projectManager.resolve({ filePath: from });
      if (!project) throw new ProjectStateError(projectNotFoundMessage(from));
      return project;
    },
    gcTime: 0,
    // A seeded project is authoritative — it is what the launching command ran
    // against — so it is never refetched from the cwd.
    ...(seed && { initialData: seed, staleTime: Infinity }),
  });
}

export interface LoadingFrameProps {
  breadcrumb: string[];
  description?: string;
  // query is whatever the screen is waiting on.
  query: Pick<UseQueryResult, "isError" | "error" | "refetch">;
  loadingLabel: string;
  onBack: () => void;
}

// LoadingFrame is the spinner-or-error a screen shows before its data arrives:
// esc leaves, and on an error `r` tries again — the PaginatedTablePicker keys.
export function LoadingFrame({
  breadcrumb,
  description,
  query,
  loadingLabel,
  onBack,
}: LoadingFrameProps) {
  useInput((input, key) => {
    if (key.escape) onBack();
    if (query.isError && input === "r") void query.refetch();
  });

  return (
    <Layout
      breadcrumb={breadcrumb}
      description={description}
      keyHints={[
        ...(query.isError ? [{ key: "r", label: "retry" }] : []),
        { key: "esc", label: "back" },
        { key: "ctl+c", label: "quit" },
      ]}
    >
      <Box paddingX={1}>
        {query.isError ? (
          <Text color={theme.colors.error}>✗ {(query.error as Error).message}</Text>
        ) : (
          <Spinner label={loadingLabel} />
        )}
      </Box>
    </Layout>
  );
}

export interface ProjectGateProps {
  core: Core;
  breadcrumb: string[];
  description?: string;
  // seed is the project already pinned on the launch context, when the command
  // that opened the TUI was itself a project command.
  seed?: Project;
  onBack: () => void;
  // children receives the resolved project and returns the screen. It must
  // return an element rather than call hooks itself — the gate renders a
  // spinner on the first paint, so a hook called here would change order.
  children: (project: Project) => React.ReactElement;
}

// ProjectGate resolves the project before rendering a project screen, showing
// the same not-found guidance the CLI prints when there is none.
export function ProjectGate({
  core,
  breadcrumb,
  description,
  seed,
  onBack,
  children,
}: ProjectGateProps) {
  const project = useProject(core, seed);
  if (project.data !== undefined) return children(project.data);
  return (
    <LoadingFrame
      breadcrumb={breadcrumb}
      description={description}
      query={project}
      loadingLabel="Loading project…"
      onBack={onBack}
    />
  );
}
