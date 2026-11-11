import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { InputValidationError } from "../errors";
import { LocalSecrets } from "./localSecrets";

export type ReadEnvFileOptions = {
  select?: (name: string) => boolean;
  overrides?: Readonly<Record<string, string | undefined>>;
};

type ReadEnvFileConfig = ReadEnvFileOptions & {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  secrets?: LocalSecrets;
};

export async function readEnvFile(
  path: string,
  config: ReadEnvFileConfig = {},
): Promise<Record<string, string>> {
  const selected = config.select ?? (() => true);
  const overrides = Object.fromEntries(
    Object.entries(config.overrides ?? {}).filter(
      ([name, value]) => selected(name) && value !== undefined,
    ),
  ) as Record<string, string>;
  let contents: string;
  try {
    contents = await (config.readFile ?? readFile)(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return overrides;
    throw new InputValidationError(`Unable to read local environment file at ${path}`, {
      cause: error,
    });
  }

  let env: Record<string, string>;
  try {
    env = parseEnv(contents) as Record<string, string>;
  } catch (error) {
    throw new InputValidationError(`Invalid local environment file at ${path}`, { cause: error });
  }

  const fromFile = Object.fromEntries(
    Object.entries(env).filter(([name]) => selected(name) && !Object.hasOwn(overrides, name)),
  );
  return { ...(await (config.secrets ?? new LocalSecrets()).decrypt(fromFile)), ...overrides };
}
