export function formatTimestamp(value: unknown): string {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function runtimeIdSuffix(value: unknown): string {
  const id = String(value ?? "");
  return id.slice(id.lastIndexOf("-") + 1);
}
