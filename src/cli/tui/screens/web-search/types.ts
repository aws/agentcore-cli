/**
 * Captured by the AddWebSearchScreen wizard and passed to the Flow, which
 * dispatches to gatewayTargetPrimitive.createWebSearchGatewayTarget().
 */
export interface AddWebSearchConfig {
  name: string;
  gateway: string;
  /** Optional list of domains to exclude from search results. */
  excludeDomains?: string[];
}
