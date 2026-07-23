import type { AppIO } from "../types";

// A field value can be supplied inline, read from a file (`file://<path>`), or
// read from stdin (`-`), following the AWS CLI `file://` convention. This avoids
// a companion `--*-file` flag for every eligible field. Each occurrence selects
// exactly one source, and a command accepts at most one stdin source.

const FILE_PREFIX = "file://";
const STDIN = "-";

// stdinReader tracks whether stdin has already been claimed within a single
// command invocation, so a second `-` is rejected rather than silently reading
// an exhausted stream.
export class SourceResolver {
  private stdinClaimed = false;

  constructor(private readonly io: AppIO) {}

  // resolve returns the effective value for a source-aware flag: the raw string
  // inline, the contents of `file://<path>`, or stdin for `-`. Undefined passes
  // through so optional flags stay omitted.
  async resolve(name: string, raw: string | undefined): Promise<string | undefined> {
    if (raw === undefined) return undefined;

    if (raw === STDIN) {
      if (this.stdinClaimed) {
        throw new TypeError(
          `only one option may read from stdin ('-'); '--${name}' cannot also read stdin`,
        );
      }
      this.stdinClaimed = true;
      return readStream(this.io.stdin);
    }

    if (raw.startsWith(FILE_PREFIX)) {
      const path = raw.slice(FILE_PREFIX.length);
      try {
        return await Bun.file(path).text();
      } catch (error) {
        throw new TypeError(
          `could not read '--${name}' from file '${path}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return raw;
  }
}

async function readStream(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
