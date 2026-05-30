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

/**
 * Converts a Result object to a JSON-serializable form.
 * Error objects have non-enumerable properties, so JSON.stringify produces `{}`.
 * This replaces the `error` field with the error message string.
 */
export function serializeResult<T extends Record<string, unknown>>(
  result: ({ success: true } & T) | ({ success: false; error: Error } & Record<string, unknown>)
): Record<string, unknown> {
  if (!result.success) {
    const { error, ...rest } = result;
    return { ...rest, error: error.message };
  }
  return result;
}

/**
 * Extracts the data portion of a Result's success branch (everything except the
 * `success` discriminant).
 */
type UnwrappedData<R extends Result> = Omit<Extract<R, { success: true }>, 'success'>;

/**
 * Unwrap a Result to its data portion.
 * - On success: returns the data (Result minus the `success: true` discriminant).
 * - On failure: throws the contained error, or returns `defaultValue` if provided.
 */
export function unwrapResult<R extends Result>(result: R): UnwrappedData<R>;
export function unwrapResult<R extends Result>(result: R, defaultValue: UnwrappedData<R>): UnwrappedData<R>;
export function unwrapResult<R extends Result>(result: R, defaultValue?: UnwrappedData<R>): UnwrappedData<R> {
  if (result.success) {
    const { success: _success, ...data } = result;
    // TS treats destructured object as generic R type and does not respect type narrowing above. Known issue: https://github.com/microsoft/TypeScript/issues/46680
    return data as UnwrappedData<R>;
  }
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw result.error;
}
