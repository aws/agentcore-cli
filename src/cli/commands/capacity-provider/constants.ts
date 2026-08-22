/**
 * Session id validation for capacity-provider data-plane operations.
 * Matches the service `SessionId` shape (GenesisCommonModel/common.smithy):
 * `@length(min:1, max:100)` + `@pattern("^[a-zA-Z0-9][a-zA-Z0-9-_]*$")`.
 * Note: unlike InvokeAgentRuntime's `runtimeSessionId`, delete has no 33-char minimum.
 */
export const CAPACITY_PROVIDER_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;
export const CAPACITY_PROVIDER_SESSION_ID_MAX_LENGTH = 100;

export function isValidCapacityProviderSessionId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= CAPACITY_PROVIDER_SESSION_ID_MAX_LENGTH &&
    CAPACITY_PROVIDER_SESSION_ID_PATTERN.test(value)
  );
}

/**
 * Capacity provider id shape (`{name}-{10 alnum}`, per the service `capacityProviderId` pattern).
 * Distinguishes a literal id from a bare project name (names have no `-{suffix}`), so a standalone
 * caller can pass the id the data-plane API actually requires. Mirrors the KB name-vs-id disambiguation.
 */
export const CAPACITY_PROVIDER_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,47}-[a-zA-Z0-9]{10}$/;

export function isCapacityProviderId(value: string): boolean {
  return CAPACITY_PROVIDER_ID_PATTERN.test(value);
}
