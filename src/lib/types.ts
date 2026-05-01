/**
 * Discriminated union for fallible operations, inspired by Rust's Result<T, E>.
 *
 * Success branch spreads T onto the result; failure branch carries an Error.
 * E extends Error so callers always get stack traces, cause chains, and instanceof narrowing.
 *
 * @example
 *   Result                                    // { success: true } | { success: false; error: Error }
 *   Result<{ name: string }>                  // { success: true; name: string } | { success: false; error: Error }
 *   Result<{ name: string }, ValidationError> // { success: true; name: string } | { success: false; error: ValidationError }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Result<T extends Record<string, unknown> = {}, E extends Error = Error> =
  | ({ success: true } & T)
  | { success: false; error: E };
