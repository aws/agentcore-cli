import { useState } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Core } from "../handlers/types.tsx";
import { HarnessScreen } from "../handlers/harness/screen.tsx";
import { HarnessGetScreen, HarnessGetJsonScreen } from "../handlers/harness/get/screen.tsx";
import { HarnessListScreen } from "../handlers/harness/list/screen.tsx";
import { HarnessCreateScreen } from "../handlers/harness/create/screen.tsx";
import { HarnessUpdateScreen } from "../handlers/harness/update/screen.tsx";
import { HarnessDeleteScreen } from "../handlers/harness/delete/screen.tsx";
import { HarnessInvokeScreen } from "../handlers/harness/invoke/screen.tsx";
import { HarnessExecScreen } from "../handlers/harness/exec/screen.tsx";
import { HarnessEndpointScreen } from "../handlers/harness/endpoint/screen.tsx";
import { HarnessCreateEndpointScreen } from "../handlers/harness/endpoint/create/screen.tsx";
import { HarnessGetEndpointScreen } from "../handlers/harness/endpoint/get/screen.tsx";
import { HarnessListEndpointsScreen } from "../handlers/harness/endpoint/list/screen.tsx";
import { HarnessUpdateEndpointScreen } from "../handlers/harness/endpoint/update/screen.tsx";
import { HarnessDeleteEndpointScreen } from "../handlers/harness/endpoint/delete/screen.tsx";
import { HarnessVersionScreen } from "../handlers/harness/version/screen.tsx";
import { HarnessGetVersionScreen } from "../handlers/harness/version/get/screen.tsx";
import { HarnessListVersionsScreen } from "../handlers/harness/version/list/screen.tsx";
import { runtimeRoutes } from "../handlers/runtime/routes.tsx";
import { RootScreen, HelpScreen } from "../handlers/screen.tsx";
import type { Context } from "../router";

export interface RootProps {
  // path is the command path to the executing node (e.g. "/agentcore").
  path: string;
  // core carries the injected service clients for use by the TUI.
  core: Core;

  ctx: Context;

  // queryClient is an optional override for the react-query client. Production
  // leaves it unset (a stable one is created per mount); tests inject one — e.g.
  // with retries disabled — to keep behavior deterministic and fast.
  queryClient?: QueryClient;
}

// Root is the top of the Ink React tree, rendered by the `agentcore` default
// handler when the CLI is invoked without a subcommand.
export function Root({ path, ctx, core, queryClient }: RootProps) {
  // Create the QueryClient once per mount; a lazy initializer keeps it stable
  // across re-renders (a fresh client would drop the cache and refetch). An
  // injected client (tests) takes precedence.
  const [defaultQueryClient] = useState(() => new QueryClient());
  const client = queryClient ?? defaultQueryClient;

  return (
    <QueryClientProvider client={client}>
      {/* initialEntries seeds the in-memory history with the CLI command path,
          then leaves navigation to the router so screens can useNavigate. */}
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="agentcore" element={<RootScreen ctx={ctx} core={core} />} />
          <Route path="agentcore/harness" element={<HarnessScreen ctx={ctx} core={core} />} />
          {/* Bare `get` (no id) has nothing to show — send the user to the list. */}
          <Route
            path="agentcore/harness/get"
            element={<Navigate to="/agentcore/harness/list" replace />}
          />
          <Route
            path="agentcore/harness/get/:harnessId"
            element={<HarnessGetScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/get/:harnessId/json"
            element={<HarnessGetJsonScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/list"
            element={<HarnessListScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/create"
            element={<HarnessCreateScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/update"
            element={<HarnessUpdateScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/update/:harnessId"
            element={<HarnessUpdateScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/delete"
            element={<HarnessDeleteScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/delete/:harnessId"
            element={<HarnessDeleteScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/invoke"
            element={<HarnessInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/invoke/:harnessId"
            element={<HarnessInvokeScreen ctx={ctx} core={core} />}
          />
          {/* Deep link that resumes an existing runtime session in the chat. */}
          <Route
            path="agentcore/harness/invoke/:harnessId/:sessionId"
            element={<HarnessInvokeScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/exec"
            element={<HarnessExecScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/exec/:harnessId"
            element={<HarnessExecScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/exec/:harnessId/:sessionId"
            element={<HarnessExecScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint"
            element={<HarnessEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/create"
            element={<HarnessCreateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/create/:harnessId"
            element={<HarnessCreateEndpointScreen ctx={ctx} core={core} />}
          />
          {/* Bare `endpoint get` (no target) has nothing to show — send the
              user to the endpoint listing (same idea for `version get`). */}
          <Route
            path="agentcore/harness/endpoint/get"
            element={<Navigate to="/agentcore/harness/endpoint/list" replace />}
          />
          <Route
            path="agentcore/harness/endpoint/get/:harnessId/:endpointName"
            element={<HarnessGetEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/list"
            element={<HarnessListEndpointsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/list/:harnessId"
            element={<HarnessListEndpointsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/update"
            element={<HarnessUpdateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/update/:harnessId"
            element={<HarnessUpdateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/update/:harnessId/:endpointName"
            element={<HarnessUpdateEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/delete"
            element={<HarnessDeleteEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/delete/:harnessId"
            element={<HarnessDeleteEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/endpoint/delete/:harnessId/:endpointName"
            element={<HarnessDeleteEndpointScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version"
            element={<HarnessVersionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version/get"
            element={<Navigate to="/agentcore/harness/version/list" replace />}
          />
          <Route
            path="agentcore/harness/version/get/:harnessId/:version"
            element={<HarnessGetVersionScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version/list"
            element={<HarnessListVersionsScreen ctx={ctx} core={core} />}
          />
          <Route
            path="agentcore/harness/version/list/:harnessId"
            element={<HarnessListVersionsScreen ctx={ctx} core={core} />}
          />
          {runtimeRoutes(ctx, core)}
          <Route path="*" element={<HelpScreen ctx={ctx} core={core} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
