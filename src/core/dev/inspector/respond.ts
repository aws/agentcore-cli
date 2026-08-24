/** Small response and parsing helpers shared by the Inspector route modules. */
import type { HttpResponse } from "../../../io/httpServer";

export function json(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function apiError(status: number, error: string): HttpResponse {
  return json(status, { success: false, error });
}

/** Parse a JSON request body, or undefined when it is not valid JSON. */
export function parseJsonBody(body: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString());
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Parse an optional epoch-milliseconds query parameter. Returns the value (or
 * undefined when absent) or an error response matching the reference wording.
 */
export function parseTimeParam(
  url: URL,
  name: string,
): { value: number | undefined; error?: HttpResponse } {
  const raw = url.searchParams.get(name);
  if (raw === null) return { value: undefined };
  const value = Number(raw);
  if (Number.isNaN(value)) {
    return {
      value: undefined,
      error: apiError(400, `${name} must be a number (epoch milliseconds)`),
    };
  }
  return { value };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
