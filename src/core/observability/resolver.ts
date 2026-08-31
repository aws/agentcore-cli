import type { CoreOptions } from "../types";

export const DEFAULT_RUNTIME_QUALIFIER = "DEFAULT";
export const DEFAULT_ENDPOINT_QUALIFIER = DEFAULT_RUNTIME_QUALIFIER;

export type ObservableResourceRef = {
  kind: "runtime";
  id: string;
  qualifier?: string;
};

export type ResolvedResourceIdentity = {
  kind: ObservableResourceRef["kind"];
  id: string;
  qualifier?: string;
};

export type LogSource = {
  provider: "cloudwatch";
  logGroupName: string;
};

export interface ResolvedObservabilityTarget {
  resource: ResolvedResourceIdentity;
  logs: readonly LogSource[];
}

export interface ObservabilitySourceResolver<R extends ObservableResourceRef> {
  resolve(
    resource: R,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<ResolvedObservabilityTarget>;
}

export type ObservabilitySourceResolverRegistry = {
  [K in ObservableResourceRef["kind"]]: ObservabilitySourceResolver<
    Extract<ObservableResourceRef, { kind: K }>
  >;
};

export function runtimeLogGroup(runtimeId: string, qualifier: string): string {
  return `/aws/bedrock-agentcore/runtimes/${runtimeId}-${qualifier}`;
}

/**
 * Resolves Runtime identity into the CloudWatch locations used by generic log
 * operations. CloudWatch access remains the source reader's responsibility.
 */
export class RuntimeSourceResolver implements ObservabilitySourceResolver<
  Extract<ObservableResourceRef, { kind: "runtime" }>
> {
  async resolve(
    resource: Extract<ObservableResourceRef, { kind: "runtime" }>,
    _options: CoreOptions,
    _signal?: AbortSignal,
  ): Promise<ResolvedObservabilityTarget> {
    const qualifier = resource.qualifier ?? DEFAULT_RUNTIME_QUALIFIER;
    return {
      resource: {
        kind: "runtime",
        id: resource.id,
        qualifier,
      },
      logs: [
        {
          provider: "cloudwatch",
          logGroupName: runtimeLogGroup(resource.id, qualifier),
        },
      ],
    };
  }
}
