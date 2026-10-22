import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runInheritedProcess, runProcess, streamProcess, toolAvailable } from "./exec";

const runners = [
  {
    name: "runProcess",
    run: (command: string[], cwd: string) => runProcess(command, { cwd }),
  },
  {
    name: "streamProcess",
    run: async (command: string[], cwd: string) => {
      for await (const _event of streamProcess(command, { cwd })) {
        // The child records its argv in a file.
      }
    },
  },
  {
    name: "runInheritedProcess",
    run: async (command: string[], cwd: string) => {
      expect(await runInheritedProcess(command, { cwd })).toBe(0);
    },
  },
  {
    name: "toolAvailable",
    run: async ([executable, ...args]: string[]) => {
      expect(await toolAvailable(executable!, args)).toBe(true);
    },
  },
];

const literalArgs = [
  "",
  "path with spaces",
  "path & (copy)",
  "percent%value%",
  "!value!",
  'embedded "quote"',
  "trail\\",
  'backslash\\"quote',
  "caret^pipe|redirect<>",
];

let directory: string;
let echoScript: string;
let shimPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentcore-argv-"));
  echoScript = join(directory, "echo.cjs");
  await writeFile(
    echoScript,
    'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));',
  );
  if (process.platform === "win32") {
    const binDirectory = join(directory, "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    shimPath = join(binDirectory, "echo-argv.cmd");
    // Match an npm shim: a batch file forwards %* to a Node script.
    await writeFile(shimPath, '@echo off\r\nnode "%~dp0\\..\\..\\echo.cjs" %*\r\n');
  }
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("literal subprocess arguments", () => {
  test.each(runners)("$name preserves arguments for native executables", async ({ name, run }) => {
    const output = join(directory, `${name}-native.json`);
    await run(["node", echoScript, output, ...literalArgs], directory);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(literalArgs);
  });
});

describe.skipIf(process.platform !== "win32")("Windows npm command shims", () => {
  test.each(runners)("$name preserves arguments through a .cmd shim", async ({ name, run }) => {
    const output = join(directory, `${name}-shim.json`);
    await run([shimPath, output, ...literalArgs], directory);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(literalArgs);
  });

  test("resolves a relative shim against the child working directory", async () => {
    const output = join(directory, "relative-shim.json");
    await runProcess([relative(directory, shimPath), output, ...literalArgs], { cwd: directory });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(literalArgs);
  });
});
