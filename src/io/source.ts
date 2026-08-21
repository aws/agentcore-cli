import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { addAbortSignal } from "node:stream";
import { buffer } from "node:stream/consumers";
import { SourceResolutionError } from "../errors";

const FILE_PREFIX = "file://";
const STDIN = "-";

export type SourceResolverConfig = {
  stdin: NodeJS.ReadStream;
  signal?: AbortSignal;
};

export class SourceResolver {
  private stdinClaimedBy?: string;

  constructor(private readonly config: SourceResolverConfig) {}

  async resolveBytes(name: string, source: string | undefined): Promise<Uint8Array | undefined> {
    if (source === undefined) return undefined;
    this.config.signal?.throwIfAborted();

    if (source === STDIN) {
      return this.readStdin(name);
    }

    if (source.startsWith(FILE_PREFIX)) {
      return this.readFile(name, source.slice(FILE_PREFIX.length));
    }

    return new TextEncoder().encode(source);
  }

  async resolveText(name: string, source: string | undefined): Promise<string | undefined> {
    const bytes = await this.resolveBytes(name, source);
    if (bytes === undefined) return undefined;

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new SourceResolutionError(`'--${name}' must contain valid UTF-8`, {
        cause: error,
      });
    }
  }

  /**
   * Resolves a secret-bearing flag while refusing inline values: an inline
   * secret leaks into shell history and process listings, so only stdin and
   * files are allowed. A single trailing newline is stripped (echo and editors
   * add one) and an embedded newline is rejected.
   */
  async resolveSecret(name: string, source: string | undefined): Promise<string | undefined> {
    if (source !== undefined && source !== STDIN && !source.startsWith(FILE_PREFIX)) {
      throw new SourceResolutionError(
        `--${name} must come from stdin ('-') or a file ('file://<path>'); ` +
          "inline secret values are not accepted",
      );
    }
    const value = await this.resolveText(name, source);
    if (value === undefined) return undefined;
    const normalized = value.replace(/\r?\n$/, "");
    if (normalized.includes("\n")) {
      throw new SourceResolutionError(`--${name} must be a single-line value`);
    }
    return normalized;
  }

  private async readStdin(name: string): Promise<Uint8Array> {
    if (this.stdinClaimedBy !== undefined) {
      throw new SourceResolutionError(
        `only one option may read from stdin; '--${name}' conflicts with ` +
          `'--${this.stdinClaimedBy}'`,
      );
    }
    this.stdinClaimedBy = name;

    // Importing Ink under Bun drains the process.stdin stream object before a
    // headless handler can claim it, while file descriptor 0 still retains the
    // bytes. Use a fresh non-closing stream for the real process input; injected
    // AppIO streams continue through the ordinary testable path.
    const source =
      this.config.stdin === process.stdin
        ? createReadStream("", { fd: 0, autoClose: false })
        : this.config.stdin;
    const stdin = this.config.signal ? addAbortSignal(this.config.signal, source) : source;
    try {
      return await buffer(stdin);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new SourceResolutionError(`could not read '--${name}' from stdin`, {
        cause: error,
      });
    }
  }

  private async readFile(name: string, path: string): Promise<Uint8Array> {
    try {
      return await readFile(path, { signal: this.config.signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new SourceResolutionError(`could not read '--${name}' from file '${path}'`, {
        cause: error,
      });
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown })?.name === "AbortError";
}
