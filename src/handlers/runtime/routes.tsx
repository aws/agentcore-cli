import type { ReactNode } from "react";
import { Navigate, Route } from "react-router";
import type { Context } from "../../router";
import type { Core } from "../types";
import { RuntimeGetEndpointScreen } from "./endpoint/get/screen";
import { RuntimeListEndpointsScreen } from "./endpoint/list/screen";
import { RuntimeEndpointScreen } from "./endpoint/screen";
import { RuntimeGetJsonScreen, RuntimeGetScreen } from "./get/screen";
import { RuntimeListScreen } from "./list/screen";
import { RuntimeScreen } from "./screen";
import { RuntimeGetVersionScreen } from "./version/get/screen";
import { RuntimeListVersionsScreen } from "./version/list/screen";
import { RuntimeVersionScreen } from "./version/screen";

export function runtimeRoutes(ctx: Context, core: Core): ReactNode {
  return (
    <>
      <Route path="agentcore/runtime" element={<RuntimeScreen ctx={ctx} core={core} />} />
      <Route
        path="agentcore/runtime/get"
        element={<Navigate to="/agentcore/runtime/list" replace />}
      />
      <Route path="agentcore/runtime/list" element={<RuntimeListScreen ctx={ctx} core={core} />} />
      <Route
        path="agentcore/runtime/get/:runtimeId"
        element={<RuntimeGetScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/get/:runtimeId/json"
        element={<RuntimeGetJsonScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/version"
        element={<RuntimeVersionScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/version/get"
        element={<Navigate to="/agentcore/runtime/version/list" replace />}
      />
      <Route
        path="agentcore/runtime/version/get/:runtimeId/:version"
        element={<RuntimeGetVersionScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/version/list"
        element={<RuntimeListVersionsScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/version/list/:runtimeId"
        element={<RuntimeListVersionsScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/endpoint"
        element={<RuntimeEndpointScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/endpoint/get"
        element={<Navigate to="/agentcore/runtime/endpoint/list" replace />}
      />
      <Route
        path="agentcore/runtime/endpoint/get/:runtimeId/:qualifier"
        element={<RuntimeGetEndpointScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/endpoint/list"
        element={<RuntimeListEndpointsScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/endpoint/list/:runtimeId"
        element={<RuntimeListEndpointsScreen ctx={ctx} core={core} />}
      />
    </>
  );
}
