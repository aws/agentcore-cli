import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findDiagnosticsInProtectedFiles,
  parseBaseline,
  verifyTypeScriptDiagnostics,
} from "./verify-ts-diagnostics";
import baselineFixture from "../test/fixtures/typescript-diagnostics.json";

const diagnostic = {
  path: "src/example.ts",
  line: 1,
  column: 1,
  code: "TS2532" as const,
  message: "Example.",
};

const validFixture = baselineFixture;
const compilerStdout = baselineFixture.diagnostics
  .map(
    (entry) =>
      `${entry.path}(${entry.line},${entry.column}): error ${entry.code}: ${entry.message.replaceAll(
        "\n",
        "\n  ",
      )}`,
  )
  .join("\n");

async function createTemporaryRepository(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "agentcore-ts-integrity-"));
  for (const entry of validFixture.legacyFileDigests) {
    const destination = join(repositoryRoot, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(process.cwd(), entry.path)));
  }
  return repositoryRoot;
}

function reviewedPath(index: number): string {
  const path = validFixture.legacyFileDigests[index]?.path;
  if (path === undefined) {
    throw new Error("Reviewed legacy path is missing.");
  }
  return path;
}

describe("TypeScript diagnostic path policy", () => {
  test("matches protected paths case-insensitively on Windows", () => {
    expect(
      findDiagnosticsInProtectedFiles([diagnostic], ["SRC\\EXAMPLE.TS"], {
        platform: "win32",
        repositoryRoot: "C:\\repo",
      }),
    ).toEqual([diagnostic]);
  });

  test("normalizes an in-repository UNC path and rejects another share", () => {
    const options = {
      platform: "win32" as const,
      repositoryRoot: "\\\\server\\share\\repo",
    };

    expect(
      findDiagnosticsInProtectedFiles(
        [diagnostic],
        ["\\\\SERVER\\SHARE\\REPO\\SRC\\EXAMPLE.TS"],
        options,
      ),
    ).toEqual([diagnostic]);
    expect(() =>
      findDiagnosticsInProtectedFiles(
        [diagnostic],
        ["\\\\server\\other\\repo\\src\\example.ts"],
        options,
      ),
    ).toThrow("Repository path is invalid.");
  });
});

describe("TypeScript diagnostic fixture", () => {
  test("accepts the reviewed digest manifest", () => {
    expect(() => parseBaseline(validFixture)).not.toThrow();
  });

  test("rejects malformed or incomplete digest manifests", () => {
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: validFixture.legacyFileDigests.slice(1),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: [...validFixture.legacyFileDigests, validFixture.legacyFileDigests[0]],
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: validFixture.legacyFileDigests.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "not-a-sha256" } : entry,
        ),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: validFixture.legacyFileDigests.map((entry, index) =>
          index === 0 ? { ...entry, path: "src/components/ui/other.ts" } : entry,
        ),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: validFixture.diagnostics.slice(1),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });

  test("rejects Identity paths in the legacy digest allowlist", () => {
    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: baselineFixture.diagnostics.map((entry, index) =>
          index === 0 ? { ...entry, path: "src/core/identity/legacy.ts" } : entry,
        ),
        legacyFileDigests: [
          ...validFixture.legacyFileDigests.slice(1),
          {
            path: "src/core/identity/legacy.ts",
            sha256: "0".repeat(64),
          },
        ],
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });

  test("rejects substitution of a reviewed path and digest pair", () => {
    const originalPath = validFixture.legacyFileDigests[0]?.path;
    const replacementPath = "src/components/ui/replacement.ts";

    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: validFixture.diagnostics.map((entry) =>
          entry.path === originalPath ? { ...entry, path: replacementPath } : entry,
        ),
        legacyFileDigests: validFixture.legacyFileDigests.map((entry) =>
          entry.path === originalPath ? { path: replacementPath, sha256: "0".repeat(64) } : entry,
        ),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });

  test("rejects reduction or addition of reviewed path and digest pairs", () => {
    const removedPath = validFixture.legacyFileDigests[0]?.path;
    const retainedPath = validFixture.legacyFileDigests[1]?.path;
    const additionalPath = "src/components/ui/additional.ts";

    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: validFixture.diagnostics.map((entry) =>
          entry.path === removedPath ? { ...entry, path: retainedPath } : entry,
        ),
        legacyFileDigests: validFixture.legacyFileDigests.slice(1),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: validFixture.diagnostics.map((entry, index) =>
          index === 0 ? { ...entry, path: additionalPath } : entry,
        ),
        legacyFileDigests: [
          ...validFixture.legacyFileDigests,
          { path: additionalPath, sha256: "0".repeat(64) },
        ],
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });

  test("rejects replacement of a reviewed digest", () => {
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: validFixture.legacyFileDigests.map((entry, index) =>
          index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry,
        ),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });

  test("rejects noncanonical diagnostic and manifest order", () => {
    expect(() =>
      parseBaseline({
        ...validFixture,
        diagnostics: [...validFixture.diagnostics].reverse(),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
    expect(() =>
      parseBaseline({
        ...validFixture,
        legacyFileDigests: [...validFixture.legacyFileDigests].reverse(),
      }),
    ).toThrow("Invalid TypeScript diagnostic baseline.");
  });
});

describe("TypeScript diagnostic verifier", () => {
  function createCommandRunner(
    compilerResult: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
    options: Readonly<{
      repositoryRoot?: string;
      beforeCompiler?: () => Promise<void>;
    }> = {},
  ) {
    const calls: Array<Readonly<{ command: readonly string[]; cwd: string }>> = [];
    return {
      calls,
      runCommand: async (command: readonly string[], cwd: string) => {
        calls.push({ command, cwd });
        if (command[0] === "git") {
          return {
            exitCode: 0,
            stdout: `${options.repositoryRoot ?? process.cwd()}\n`,
            stderr: "",
          };
        }
        if (command.at(-1) === "--version") {
          return { exitCode: 0, stdout: "Version 5.9.3\n", stderr: "" };
        }
        await options.beforeCompiler?.();
        return compilerResult;
      },
    };
  }

  function createTrackedFileSystem(
    options: Readonly<{
      targetPath?: string;
      afterSecondInitialRead?: () => Promise<void>;
    }> = {},
  ) {
    let closeCount = 0;
    let initialReadCount = 0;
    return {
      get closeCount() {
        return closeCount;
      },
      fileSystem: {
        lstat: (path: string) => lstat(path, { bigint: true }),
        realpath,
        open: async (path: string, flags: number) => {
          const handle = await open(path, flags);
          return new Proxy(handle, {
            get(target, property) {
              if (property === "close") {
                return async () => {
                  closeCount += 1;
                  await target.close();
                };
              }
              if (property === "read" && path === options.targetPath) {
                return async (buffer: Buffer, offset: number, length: number, position: number) => {
                  const result = await target.read(buffer, offset, length, position);
                  if (position === 0) {
                    initialReadCount += 1;
                    if (initialReadCount === 2) {
                      await options.afterSecondInitialRead?.();
                    }
                  }
                  return result;
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    };
  }

  test("orchestrates the exact production commands without a historical Git base", async () => {
    const commands = createCommandRunner({ exitCode: 2, stdout: compilerStdout, stderr: "" });
    const baseline = parseBaseline(validFixture);
    const result = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: commands.runCommand,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        `TypeScript diagnostic baseline matched: ${baseline.diagnostics.length} diagnostics.`,
        `Reviewed legacy diagnostic files unchanged: ${baseline.legacyFileDigests.length} files.`,
        "Non-baseline TypeScript files clean: 0 diagnostics.",
      ],
      stderr: [],
    });
    expect(commands.calls).toEqual([
      {
        command: ["git", "rev-parse", "--show-toplevel"],
        cwd: process.cwd(),
      },
      {
        command: ["bunx", "tsc", "--version"],
        cwd: process.cwd(),
      },
      {
        command: ["bunx", "tsc", "--noEmit", "--pretty", "false"],
        cwd: process.cwd(),
      },
    ]);
  });

  test.each([
    { name: "exit 137", exitCode: 137, stdout: compilerStdout, stderr: "" },
    { name: "wrong diagnostic exit", exitCode: 1, stdout: compilerStdout, stderr: "" },
    { name: "stderr", exitCode: 2, stdout: compilerStdout, stderr: "secret stderr" },
    {
      name: "crash text",
      exitCode: 2,
      stdout: `${compilerStdout}\nfatal: compiler crashed`,
      stderr: "",
    },
  ])("rejects incomplete compiler execution: $name", async ({ exitCode, stdout, stderr }) => {
    const commands = createCommandRunner({ exitCode, stdout, stderr });
    const result = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: commands.runCommand,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual(["TypeScript diagnostic verification failed."]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("fatal");
  });

  test("rejects diagnostics from a changed reviewed legacy file", async () => {
    const repositoryRoot = await createTemporaryRepository();
    try {
      await writeFile(join(repositoryRoot, reviewedPath(0)), "changed legacy file");
      const commands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        { repositoryRoot },
      );
      const result = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: repositoryRoot,
        platform: process.platform,
        runCommand: commands.runCommand,
      });

      expect(result).toEqual({
        exitCode: 1,
        stdout: [],
        stderr: ["Reviewed legacy TypeScript file changed."],
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("rejects final symlinks and symlinked parents that escape the repository", async () => {
    const finalSymlinkRoot = await createTemporaryRepository();
    const parentSymlinkRoot = await createTemporaryRepository();
    const outsideRoot = await mkdtemp(join(tmpdir(), "agentcore-ts-integrity-outside-"));
    try {
      const finalPath = join(finalSymlinkRoot, reviewedPath(0));
      await rm(finalPath);
      await symlink(join(process.cwd(), reviewedPath(0)), finalPath, "file");

      const finalCommands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        { repositoryRoot: finalSymlinkRoot },
      );
      const finalResult = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: finalSymlinkRoot,
        platform: process.platform,
        runCommand: finalCommands.runCommand,
      });
      expect(finalResult.exitCode).toBe(1);

      await rm(finalPath);
      await mkdir(finalPath);
      const nonRegularResult = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: finalSymlinkRoot,
        platform: process.platform,
        runCommand: finalCommands.runCommand,
      });
      expect(nonRegularResult.exitCode).toBe(1);

      const parentPath = dirname(join(parentSymlinkRoot, reviewedPath(0)));
      const outsideParent = join(outsideRoot, "data-table");
      await mkdir(outsideParent, { recursive: true });
      await writeFile(
        join(outsideParent, "DataTable.tsx"),
        await readFile(join(process.cwd(), reviewedPath(0))),
      );
      await rm(parentPath, { recursive: true });
      await symlink(outsideParent, parentPath, "dir");

      const parentCommands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        { repositoryRoot: parentSymlinkRoot },
      );
      const parentResult = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: parentSymlinkRoot,
        platform: process.platform,
        runCommand: parentCommands.runCommand,
      });
      expect(parentResult.exitCode).toBe(1);
    } finally {
      await Promise.all([
        rm(finalSymlinkRoot, { recursive: true, force: true }),
        rm(parentSymlinkRoot, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("rejects path replacement during compiler execution", async () => {
    const repositoryRoot = await createTemporaryRepository();
    try {
      const targetPath = join(repositoryRoot, reviewedPath(0));
      const originalBytes = await readFile(targetPath);
      const commands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        {
          repositoryRoot,
          beforeCompiler: async () => {
            const replacementPath = `${targetPath}.replacement`;
            await writeFile(replacementPath, originalBytes);
            await rename(targetPath, `${targetPath}.original`);
            await rename(replacementPath, targetPath);
          },
        },
      );

      const result = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: repositoryRoot,
        platform: process.platform,
        runCommand: commands.runCommand,
      });

      expect(result.exitCode).toBe(1);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("rejects path replacement during the post-compiler handle hash", async () => {
    const repositoryRoot = await createTemporaryRepository();
    try {
      const targetPath = join(repositoryRoot, reviewedPath(0));
      const replacementPath = `${targetPath}.replacement`;
      await writeFile(replacementPath, await readFile(targetPath));
      const tracker = createTrackedFileSystem({
        targetPath,
        afterSecondInitialRead: async () => {
          await rename(targetPath, `${targetPath}.original`);
          await rename(replacementPath, targetPath);
        },
      });
      const commands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        { repositoryRoot },
      );

      const result = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: repositoryRoot,
        platform: process.platform,
        runCommand: commands.runCommand,
        fileSystem: tracker.fileSystem,
      });

      expect({ exitCode: result.exitCode, closeCount: tracker.closeCount }).toEqual({
        exitCode: 1,
        closeCount: 3,
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("rejects a parent symlink escape restored during compiler execution", async () => {
    const repositoryRoot = await createTemporaryRepository();
    const outsideRoot = await mkdtemp(join(tmpdir(), "agentcore-ts-integrity-outside-"));
    try {
      const targetPath = join(repositoryRoot, reviewedPath(0));
      const parentPath = dirname(targetPath);
      const originalParentPath = `${parentPath}.original`;
      const outsideParentPath = join(outsideRoot, "data-table");
      await mkdir(outsideParentPath, { recursive: true });
      await writeFile(
        join(outsideParentPath, "DataTable.tsx"),
        await readFile(join(process.cwd(), reviewedPath(0))),
      );
      const commands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        {
          repositoryRoot,
          beforeCompiler: async () => {
            await rename(parentPath, originalParentPath);
            await symlink(outsideParentPath, parentPath, "dir");
            await Bun.sleep(10);
            await rm(parentPath);
            await rename(originalParentPath, parentPath);
          },
        },
      );

      const result = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: repositoryRoot,
        platform: process.platform,
        runCommand: commands.runCommand,
      });

      expect(result.exitCode).toBe(1);
    } finally {
      await Promise.all([
        rm(repositoryRoot, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("rejects in-place mutation restored during compiler execution", async () => {
    const repositoryRoot = await createTemporaryRepository();
    try {
      const targetPath = join(repositoryRoot, reviewedPath(0));
      const originalBytes = await readFile(targetPath);
      const commands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        {
          repositoryRoot,
          beforeCompiler: async () => {
            await writeFile(targetPath, "temporary mutation");
            await Bun.sleep(10);
            await writeFile(targetPath, originalBytes);
          },
        },
      );

      const result = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: repositoryRoot,
        platform: process.platform,
        runCommand: commands.runCommand,
      });

      expect(result.exitCode).toBe(1);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("closes retained file handles on success and failure", async () => {
    const successTracker = createTrackedFileSystem();
    const successCommands = createCommandRunner({
      exitCode: 2,
      stdout: compilerStdout,
      stderr: "",
    });
    const successResult = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: successCommands.runCommand,
      fileSystem: successTracker.fileSystem,
    });
    expect(successResult.exitCode).toBe(0);
    expect(successTracker.closeCount).toBe(3);

    const compilerFailureTracker = createTrackedFileSystem();
    const compilerFailureCommands = createCommandRunner({
      exitCode: 137,
      stdout: compilerStdout,
      stderr: "",
    });
    const compilerFailureResult = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: compilerFailureCommands.runCommand,
      fileSystem: compilerFailureTracker.fileSystem,
    });
    expect(compilerFailureResult.exitCode).toBe(1);
    expect(compilerFailureTracker.closeCount).toBe(3);

    const acquisitionFailureRoot = await createTemporaryRepository();
    try {
      const secondPath = join(acquisitionFailureRoot, reviewedPath(1));
      await rm(secondPath);
      await symlink(join(process.cwd(), reviewedPath(1)), secondPath, "file");
      const acquisitionFailureTracker = createTrackedFileSystem();
      const acquisitionFailureCommands = createCommandRunner(
        { exitCode: 2, stdout: compilerStdout, stderr: "" },
        { repositoryRoot: acquisitionFailureRoot },
      );
      const acquisitionFailureResult = await verifyTypeScriptDiagnostics({
        fixture: validFixture,
        cwd: acquisitionFailureRoot,
        platform: process.platform,
        runCommand: acquisitionFailureCommands.runCommand,
        fileSystem: acquisitionFailureTracker.fileSystem,
      });
      expect(acquisitionFailureResult.exitCode).toBe(1);
      expect(acquisitionFailureTracker.closeCount).toBe(1);
    } finally {
      await rm(acquisitionFailureRoot, { recursive: true, force: true });
    }
  });

  test("keeps malformed fixtures and unknown failures static and secret-safe", async () => {
    const commands = createCommandRunner({ exitCode: 2, stdout: compilerStdout, stderr: "" });
    const malformedResult = await verifyTypeScriptDiagnostics({
      fixture: { ...validFixture, legacyFileDigests: [] },
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: commands.runCommand,
    });
    const unknownResult = await verifyTypeScriptDiagnostics({
      fixture: validFixture,
      cwd: process.cwd(),
      platform: process.platform,
      runCommand: async () => {
        throw new Error("unknown secret");
      },
    });

    expect(malformedResult).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ["TypeScript diagnostic verification failed."],
    });
    expect(unknownResult).toEqual(malformedResult);
    expect(JSON.stringify(unknownResult)).not.toContain("unknown secret");
  });

  test("runs the actual verifier entrypoint with static output", async () => {
    const child = Bun.spawn([process.execPath, "scripts/verify-ts-diagnostics.ts"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      [
        "TypeScript diagnostic baseline matched: 29 diagnostics.",
        "Reviewed legacy diagnostic files unchanged: 3 files.",
        "Non-baseline TypeScript files clean: 0 diagnostics.",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
  }, 20_000);

  test("keeps actual entrypoint failures static", async () => {
    const scriptPath = join(process.cwd(), "scripts", "verify-ts-diagnostics.ts");
    const child = Bun.spawn([process.execPath, scriptPath], {
      cwd: tmpdir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("TypeScript diagnostic verification failed.\n");
  });
});
