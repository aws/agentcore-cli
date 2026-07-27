import { readFile } from "node:fs/promises";
import { addAbortSignal } from "node:stream";
import { buffer } from "node:stream/consumers";
import { InputValidationError } from "../errors";

const FILE_PREFIX = "file://";
const STDIN = "-";

export type SourceResolverConfig = {
  stdin?: NodeJS.ReadStream;
  signal?: AbortSignal;
};

export class SourceResolutionError extends InputValidationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceResolutionError";
  }
}

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

  private async readStdin(name: string): Promise<Uint8Array> {
    if (!this.config.stdin) {
      throw new SourceResolutionError(`stdin is not available for '--${name}'`);
    }
    if (this.stdinClaimedBy !== undefined) {
      throw new SourceResolutionError(
        `only one option may read from stdin; '--${name}' conflicts with ` +
          `'--${this.stdinClaimedBy}'`,
      );
    }
    this.stdinClaimedBy = name;

    const stdin = this.config.signal
      ? addAbortSignal(this.config.signal, this.config.stdin)
      : this.config.stdin;
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
