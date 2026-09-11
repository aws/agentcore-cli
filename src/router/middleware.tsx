import type { Handler } from "./handler";

export type Middleware = (handler: Handler) => Handler;

// A node may carry its own middleware, applied to it and its subtree. Routers
// implement this via `use()`; leaf handlers via createHandler's `middlewares`.
export interface MiddlewareProvider {
  middlewares(): Middleware[];
}

export function isMiddlewareProvider(h: Handler): h is Handler & MiddlewareProvider {
  return typeof (h as Partial<MiddlewareProvider>).middlewares === "function";
}
