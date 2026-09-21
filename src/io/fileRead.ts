import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { DeserializationError } from "../errors";

export type ReadTextFileOptions = {
  signal?: AbortSignal;
};

export async function readTextFile(
  path: string,
  options: ReadTextFileOptions = {},
): Promise<string> {
  return readFile(path, { encoding: "utf8", signal: options.signal });
}

export async function readYamlFile(path: string): Promise<unknown> {
  try {
    const document = parseDocument(await readTextFile(path));
    if (document.errors.length) throw document.errors[0];
    return document.toJS();
  } catch (error) {
    throw new DeserializationError(path, {
      cause: error,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
