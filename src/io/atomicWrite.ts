import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type AtomicWriteStreamSource =
  ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | NodeJS.ReadableStream;

export interface AtomicWriteStreamOptions {
  signal?: AbortSignal;
  transforms?: Transform[];
}

export interface AtomicWriteOptions {
  mode?: number;
}

export async function atomicWrite(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, contents, { mode: options.mode });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function atomicWriteStream(
  path: string,
  source: AtomicWriteStreamSource,
  options: AtomicWriteStreamOptions = {},
): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await pipeline(
      streamSource(source),
      ...(options.transforms ?? []),
      createWriteStream(tempPath),
      { signal: options.signal },
    );
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function streamSource(source: AtomicWriteStreamSource): NodeJS.ReadableStream {
  if (source instanceof Readable) return source;
  if (typeof ReadableStream !== "undefined" && source instanceof ReadableStream) {
    return Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]);
  }
  return Readable.from(source as AsyncIterable<Uint8Array>);
}
