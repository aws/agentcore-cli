import type z from "zod";
import type { ObservableResourceRef } from "../../core/observability";
import type { CoreOptions } from "../../core/types";
import type { Context, Flag } from "../../router";

export type ResourceFlagValues<F extends readonly Flag<string, unknown>[]> = {
  [E in F[number] as E["name"]]: E extends Flag<string, infer T> ? z.infer<z.ZodType<T>> : never;
};

export interface ObservableResourceCommand<
  K extends ObservableResourceRef["kind"],
  F extends readonly Flag<string, unknown>[],
> {
  flags: F;
  resolve(
    flags: ResourceFlagValues<F>,
    ctx: Context,
  ): ResolvedObservableResource<K> | Promise<ResolvedObservableResource<K>>;
}

export type ResolvedObservableResource<K extends ObservableResourceRef["kind"]> = {
  resource: Extract<ObservableResourceRef, { kind: K }>;
  options?: CoreOptions;
};
