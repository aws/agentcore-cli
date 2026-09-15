import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { DeserializationError } from "../errors";

const MAX_PROMPT_FILE_SIZE = 1024 * 1024;
const PROMPT_FIELDS = [
  ["systemPrompt"],
  ["truncation", "config", "summarization", "summarizationSystemPrompt"],
] as const;

/** Project-file I/O only; callers validate the resolved data with their HarnessSpecSchema. */
export class HarnessConfigReader {
  async read(filePath: string): Promise<unknown> {
    const configPath = resolve(filePath);
    try {
      const raw = await readFile(configPath, "utf8");
      const document = parseDocument(raw);
      if (document.errors.length) throw document.errors[0];
      const data: unknown = document.toJS();
      if (!isRecord(data)) return data;

      // These are the only local-file fields. Skills and other runtime paths stay untouched.
      promptFields: for (const keys of PROMPT_FIELDS) {
        let parent = data;
        for (const key of keys.slice(0, -1)) {
          const child = parent[key];
          if (!isRecord(child)) continue promptFields;
          parent[key] = { ...child };
          parent = parent[key] as Record<string, unknown>;
        }
        const key = keys[keys.length - 1]!;
        const value = parent[key];
        if (typeof value === "string" && value.startsWith("file://")) {
          const source = value.slice("file://".length);
          if (!source) throw new Error(`${keys.join(".")}: file:// requires a path`);
          parent[key] = await this.readPrompt(resolve(dirname(configPath), source), keys.join("."));
        }
      }
      if (data.systemPrompt === undefined) {
        const fallback = join(dirname(configPath), "system-prompt.md");
        try {
          data.systemPrompt = await this.readPrompt(fallback, "systemPrompt");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return data;
    } catch (error) {
      throw new DeserializationError(configPath, {
        cause: error,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readPrompt(filePath: string, field: string): Promise<string> {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error(`${field}: '${filePath}' is not a regular prompt file`);
      // A path can change after stat; nonblocking POSIX opens avoid waiting on a replacement FIFO.
      const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
      const file = await open(filePath, flags);
      try {
        if (!(await file.stat()).isFile())
          throw new Error(`${field}: '${filePath}' is not a regular prompt file`);
        const bytes = Buffer.alloc(MAX_PROMPT_FILE_SIZE + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_PROMPT_FILE_SIZE) {
          throw new Error(`${field}: prompt file '${filePath}' exceeds the 1 MiB limit`);
        }
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, length),
        );
        if (!text.trim())
          throw new Error(`${field}: prompt file '${filePath}' is empty or whitespace-only`);
        return text;
      } finally {
        await file.close();
      }
    } catch (error) {
      throw Object.assign(
        new Error(
          `${field}: cannot read prompt file '${filePath}': ${error instanceof Error ? error.message : error}`,
          {
            cause: error,
          },
        ),
        { code: (error as NodeJS.ErrnoException).code },
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
