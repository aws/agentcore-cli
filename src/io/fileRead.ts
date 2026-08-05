export type ReadTextFileOptions = {
  signal?: AbortSignal;
};

export async function readTextFile(
  path: string,
  options: ReadTextFileOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const text = await Bun.file(path).text();
  options.signal?.throwIfAborted();
  return text;
}
