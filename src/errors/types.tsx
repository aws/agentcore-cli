export const ERROR_SOURCE = {
  // note: this maps to the `client` error source in telemetry.
  INTERNAL: "internal",
  USER: "user",
  SERVICE: "service",
  UNKNOWN: "unknown",
} as const;

/** Describes the source of the error, whether it was the user, internal to the CLI, a service, or unknown. */
export type ErrorSource = (typeof ERROR_SOURCE)[keyof typeof ERROR_SOURCE];
