import type { ReactNode } from "react";
import { Route } from "react-router";
import type { Context } from "../../router";
import type { Core } from "../types";
import { RuntimeEndpointScreen } from "./endpoint/screen";
import { RuntimeScreen } from "./screen";
import { RuntimeVersionScreen } from "./version/screen";

export function runtimeRoutes(ctx: Context, core: Core): ReactNode {
  return (
    <>
      <Route path="agentcore/runtime" element={<RuntimeScreen ctx={ctx} core={core} />} />
      <Route
        path="agentcore/runtime/version"
        element={<RuntimeVersionScreen ctx={ctx} core={core} />}
      />
      <Route
        path="agentcore/runtime/endpoint"
        element={<RuntimeEndpointScreen ctx={ctx} core={core} />}
      />
    </>
  );
}
