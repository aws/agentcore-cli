export function withoutSdkMetadata(data: unknown): unknown {
  if (data === null || typeof data !== "object" || !("$metadata" in data)) return data;

  const normalized = { ...(data as Record<string, unknown>) };
  delete normalized.$metadata;
  return normalized;
}
