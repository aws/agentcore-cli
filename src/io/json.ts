import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import z from "zod";

import { DeserializationError } from "../errors";
import type { Logger } from "../logging";
import type { ReadWriteJson } from "./types";

type ReadWriteJsonConfig = {
  logger: Logger;
};

/**
 * Implements {@link ReadWriteJson} through node fs.
 *
 * @param config - logger
 */
export class FsReadWriteJson implements ReadWriteJson {
  private readonly logger: Logger;

  constructor(config: ReadWriteJsonConfig) {
    this.logger = config.logger;
  }

  private async readJsonFile(filePath: string): Promise<unknown> {
    const raw = await readFile(filePath, "utf8");

    try {
      return JSON.parse(raw);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger
        .child({ filePath, errorName: error.name, errorMessage: error.message })
        .error(`failed to parse json file`);
      throw new DeserializationError(filePath, { cause: e, details: error.message });
    }
  }

  public async read<TSchema extends z.ZodType>(
    filePath: string,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> {
    const data = await this.readJsonFile(filePath);
    const parseResult = schema.safeParse(data);

    if (!parseResult.success) {
      this.logger
        .child({
          filePath,
          errorName: parseResult.error.name,
          errorMessage: parseResult.error.message,
        })
        .error(`failed to validate parsed json file`);
      throw new DeserializationError(filePath, {
        cause: parseResult.error,
        details: z.prettifyError(parseResult.error),
      });
    }

    return parseResult.data;
  }

  public async write<TData extends object>(filePath: string, data: TData): Promise<TData> {
    const contents = JSON.stringify(data, undefined, 2);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
    return data;
  }
}
