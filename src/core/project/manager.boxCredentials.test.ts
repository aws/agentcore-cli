import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsProjectManager } from "./manager";
import type { Project, ProjectEvent } from "../../handlers/project/types";
import type { ProjectBackend } from "./backends/types";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "./envLocal";
import { boxLocalDir, boxLocalProfileFile } from "./templates/boxProfile";
import { boxShowOf, FakeBoxProfileResolver } from "./boxProfileResolver-test-support";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import { ENC_PREFIX } from "../../secrets/cipher";
import { createSilentLogger, TestIdentityClient } from "../../testing";

// A box template: only it writes the box profile whose env:// secrets build provisions.
const AGENT_PYTHON = resolveRuntimeTemplateShortcut("agent-python-strands-box");
/** The local box profile of the template's runtime, from the project root. */
const BOX_PROFILE_FILE = boxLocalProfileFile(AGENT_PYTHON.runtimeName);
const GITHUB_PROFILE =
  '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n';
/** What box resolves {@link GITHUB_PROFILE} to. */
const GITHUB_SHOWN = boxShowOf({
  egress: { github: { destinations: ["api.github.com"], secret: { ref: "env://GITHUB_TOKEN" } } },
});
const RESERVED = credentialEnvVarName("github");
/** A stored secret in the encrypted format that no key on this machine decrypts. */
const UNDECRYPTABLE = `${ENC_PREFIX}${Buffer.alloc(48).toString("base64")}`;

const originalCwd = process.cwd();
const directories: string[] = [];
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A manager whose CDK backend records the project it builds, and runs nothing. */
function manager(
  processEnv: NodeJS.ProcessEnv,
  shown = GITHUB_SHOWN,
): { subject: FsProjectManager; built: Project[] } {
  const built: Project[] = [];
  const backend: ProjectBackend = {
    async *build(project) {
      built.push(project);
      yield { type: "step", message: "synthesizing" };
    },
    async *deploy() {
      yield { type: "step", message: "deploying" };
      return { outputs: {} };
    },
    async resolveDeployedResources() {
      return [];
    },
    async resolveProjectResources() {
      return [];
    },
  };
  const subject = new FsProjectManager({
    logger: createSilentLogger(),
    processEnv,
    identity: new TestIdentityClient(),
    enableTransactionSearch: async () => {},
    runner: async () => {},
    checkTool: async () => {},
    backends: { CDK: backend },
    boxProfileResolver: new FakeBoxProfileResolver(shown),
  });
  return { subject, built };
}

/** A new project in a temporary folder whose box profile is `profile`. */
async function project(subject: FsProjectManager, profile: string): Promise<Project> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-box-credentials-"));
  directories.push(directory);
  process.chdir(directory);
  const iterator = subject.create({
    name: "example",
    scaffoldRuntimeInput: AGENT_PYTHON,
    skipInstall: true,
    skipGit: true,
  });
  let next = await iterator.next();
  while (!next.done) next = await iterator.next();
  const created = next.value;
  await mkdir(join(created.rootPath, boxLocalDir(AGENT_PYTHON.runtimeName)), { recursive: true });
  await writeFile(join(created.rootPath, BOX_PROFILE_FILE), profile);
  return created;
}

/** The step messages of `generator`, then its warnings. */
async function drain(
  generator: AsyncGenerator<ProjectEvent, void>,
): Promise<{ steps: string[]; warnings: string[] }> {
  const steps: string[] = [];
  const warnings: string[] = [];
  for await (const event of generator) {
    if (event.type === "step") steps.push(event.message);
    else if (event.type === "warning") warnings.push(event.message);
  }
  return { steps, warnings };
}

/** Appends `line` to the project's `.env.local` as written, so no value in it is encrypted. */
async function appendEnvLocal(root: string, line: string): Promise<void> {
  await mkdir(join(root, "agentcore"), { recursive: true });
  await appendFile(join(root, ENV_LOCAL_RELATIVE_PATH), `\n${line}\n`);
}

/** The key build stored under the credential's reserved variable; reads no other entry. */
async function storedKey(root: string): Promise<string | undefined> {
  return (await new EnvLocalFile(root).read({ select: (name) => name === RESERVED }))[RESERVED];
}

async function specOf(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "agentcore", "agentcore.json"), "utf8"));
}

describe("FsProjectManager.build: box env:// credentials", () => {
  test("declares the credential, seeds its key, and builds with the new spec", async () => {
    const { subject, built } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, GITHUB_PROFILE);
    const before = await specOf(created.rootPath);

    const { steps } = await drain(subject.build(created));

    const after = await specOf(created.rootPath);
    expect(after.credentials).toEqual([
      ...((before.credentials as unknown[] | undefined) ?? []),
      { authorizerType: "ApiKeyCredentialProvider", name: "github" },
    ]);
    // Only `credentials` and the Box gateway change: every other field keeps its value and place.
    const others = (spec: Record<string, unknown>) =>
      Object.entries(spec).filter(([key]) => !["credentials", "agentCoreGateways"].includes(key));
    expect(others(after)).toEqual(others(before));
    const stored = await new EnvLocalFile(created.rootPath).read();
    expect(stored[RESERVED]).toBe("ghp_shell");
    expect(steps).toContain(`writing ${RESERVED} to ${ENV_LOCAL_RELATIVE_PATH}`);
    expect(built[0]?.spec.credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "github",
    });
  });

  test("a second build changes nothing", async () => {
    const { subject } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, GITHUB_PROFILE);
    await drain(subject.build(created));
    const spec = await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8");
    const reread = await subject.resolve({ filePath: created.rootPath });

    const { steps, warnings } = await drain(subject.build(reread!));

    expect([...steps, ...warnings].filter((message) => message.includes("github"))).toEqual([]);
    expect(await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8")).toBe(
      spec,
    );
  });

  test("a second build finds the key stored only under the credential's reserved variable", async () => {
    const { subject: first } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(first, GITHUB_PROFILE);
    await drain(first.build(created));
    const { subject } = manager({});
    const reread = await subject.resolve({ filePath: created.rootPath });

    const { steps, warnings } = await drain(subject.build(reread!));

    expect(
      [...steps, ...warnings].filter((message) => message.includes("env://GITHUB_TOKEN")),
    ).toEqual([]);
    expect(await storedKey(created.rootPath)).toBe("ghp_shell");
  });

  test("seeds the key that agentcore dev stored in .env.local under the box variable", async () => {
    const { subject } = manager({});
    const created = await project(subject, GITHUB_PROFILE);
    await new EnvLocalFile(created.rootPath).insertIfNew([
      { key: "GITHUB_TOKEN", value: "ghp_stored", comment: "stored by agentcore dev" },
    ]);

    await drain(subject.build(created));

    expect((await new EnvLocalFile(created.rootPath).read())[RESERVED]).toBe("ghp_stored");
  });

  test("adds no credential, and says which variable to set, when the key is in neither place", async () => {
    const { subject } = manager({});
    const created = await project(subject, GITHUB_PROFILE);
    const credentials = async () =>
      JSON.parse(await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8"))
        .credentials;
    const before = await credentials();

    const { steps } = await drain(subject.build(created));

    expect(steps).toContain(
      "not adding credential 'github' for box egress 'env://GITHUB_TOKEN': GITHUB_TOKEN is not " +
        `set here or in ${ENV_LOCAL_RELATIVE_PATH}, so deploy could not provision it. ` +
        `Set GITHUB_TOKEN, or ${RESERVED}, and build again`,
    );
    // Build still adds the model's target, so only the credentials stay as they were.
    expect(await credentials()).toEqual(before);
  });

  test("builds when .env.local holds an undecryptable entry that no route uses", async () => {
    const { subject, built } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, GITHUB_PROFILE);
    await appendEnvLocal(created.rootPath, `OTHER_API_KEY='${UNDECRYPTABLE}'`);

    await drain(subject.build(created));

    expect(built[0]?.spec.credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "github",
    });
    expect(await storedKey(created.rootPath)).toBe("ghp_shell");
  });

  test("seeds a blank reserved variable when .env.local also holds an unused undecryptable entry", async () => {
    const { subject } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, GITHUB_PROFILE);
    await writeFile(join(created.rootPath, ENV_LOCAL_RELATIVE_PATH), `${RESERVED}=\n`);
    await appendEnvLocal(created.rootPath, `OTHER_API_KEY='${UNDECRYPTABLE}'`);

    await drain(subject.build(created));

    expect(await storedKey(created.rootPath)).toBe("ghp_shell");
  });

  test("builds when .env.local holds an undecryptable key of a model-provider route", async () => {
    const { subject, built } = manager(
      {},
      boxShowOf({
        egress: {
          openai: { destinations: ["api.openai.com"], secret: { ref: "env://OPENAI_API_KEY" } },
        },
      }),
    );
    const created = await project(
      subject,
      '[egress.openai]\ndestinations = ["api.openai.com"]\nsecret.ref = "env://OPENAI_API_KEY"\n',
    );
    await appendEnvLocal(created.rootPath, `OPENAI_API_KEY='${UNDECRYPTABLE}'`);

    await drain(subject.build(created));

    expect(built).toHaveLength(1);
  });

  test("builds when the shell sets the variable of an undecryptable .env.local entry", async () => {
    const { subject, built } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, GITHUB_PROFILE);
    await appendEnvLocal(created.rootPath, `GITHUB_TOKEN='${UNDECRYPTABLE}'`);

    await drain(subject.build(created));

    expect(built[0]?.spec.credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "github",
    });
    expect(await storedKey(created.rootPath)).toBe("ghp_shell");
  });

  test.each([
    ["the shell does not set it", {}],
    ["the shell sets it blank", { GITHUB_TOKEN: " " }],
  ])(
    "stops on an undecryptable .env.local entry that a route uses when %s",
    async (_label, env: NodeJS.ProcessEnv) => {
      const { subject, built } = manager(env);
      const created = await project(subject, GITHUB_PROFILE);
      await appendEnvLocal(created.rootPath, `GITHUB_TOKEN='${UNDECRYPTABLE}'`);
      const spec = await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8");

      await expect(drain(subject.build(created))).rejects.toThrow(
        "Could not decrypt a stored secret in agentcore/.env.local. " +
          "Restore the original encryption key or re-add the credential.",
      );
      expect(built).toEqual([]);
      expect(await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8")).toBe(
        spec,
      );
    },
  );

  test("stops on a box profile that does not parse, and changes nothing", async () => {
    const { subject } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, "[egress.github\n");
    const spec = await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8");

    await expect(drain(subject.build(created))).rejects.toThrow(
      `${BOX_PROFILE_FILE}:1:15  This is not valid TOML`,
    );
    expect(await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8")).toBe(
      spec,
    );
  });
});
