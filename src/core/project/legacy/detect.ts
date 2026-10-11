export type ProjectFormat = "v0" | "v1";

/** v0 CLIs write `version: 1`; anything else is validated as a v1 spec. */
export function projectFormat(raw: unknown): ProjectFormat {
  return typeof raw === "object" && raw !== null && (raw as { version?: unknown }).version === 1
    ? "v0"
    : "v1";
}
