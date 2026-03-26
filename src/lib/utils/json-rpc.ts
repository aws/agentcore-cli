/** Parse a JSON-RPC response, handling both plain JSON and SSE-wrapped formats. Throws if no valid response is found. */
export function parseJsonRpcResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Might be SSE format
  }

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6)) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
  }

  throw new Error(`Failed to parse JSON-RPC response: ${trimmed.slice(0, 200)}`);
}
