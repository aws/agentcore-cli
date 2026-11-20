/** An `[egress.<route>]` of the box profile whose `secret.ref` is `env://<variable>`. */
export type BoxEnvRoute = { route: string; variable: string };

/** Whether an environment value holds a key: set, and not blank. */
export function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
