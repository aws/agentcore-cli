import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsProjectManager } from "./manager";
import type { Project, ProjectEvent } from "../../handlers/project/types";
import type { ProjectBackend } from "./backends/types";
import { ENV_LOCAL_RELATIVE_PATH, EnvLocalFile } from "./envLocal";
import { BOX_PROFILE_FILE } from "./templates/boxProfile";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import { createSilentLogger, TestIdentityClient } from "../../testing";

const AGENT_PYTHON = resolveRuntimeTemplateShortcut("agent-python-minimal");
const GITHUB_PROFILE =
  '[egress.github]\nhost = "api.github.com"\nsecret.ref = "env://GITHUB_TOKEN"\n';
const RESERVED = credentialEnvVarName("github");

const originalCwd = process.cwd();
const directories: string[] = [];
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A manager whose CDK backend records the project it builds, and runs nothing. */
function manager(processEnv: NodeJS.ProcessEnv): { subject: FsProjectManager; built: Project[] } {
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
  await mkdir(join(created.rootPath, ".box"), { recursive: true });
  await writeFile(join(created.rootPath, BOX_PROFILE_FILE), profile);
  return created;
}

async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<string[]> {
  const messages: string[] = [];
  for await (const event of generator) if (event.type === "step") messages.push(event.message);
  return messages;
}

async function specOf(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "agentcore", "agentcore.json"), "utf8"));
}

describe("FsProjectManager.build: box env:// credentials", () => {
  test("declares the credential, seeds its key, and builds with the new spec", async () => {
    const { subject, built } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, GITHUB_PROFILE);
    const before = await specOf(created.rootPath);

    const messages = await drain(subject.build(created));

    const after = await specOf(created.rootPath);
    expect(after.credentials).toEqual([
      ...((before.credentials as unknown[] | undefined) ?? []),
      { authorizerType: "ApiKeyCredentialProvider", name: "github" },
    ]);
    // Only `credentials` changes: every other field keeps its value and its place.
    const others = (spec: Record<string, unknown>) =>
      Object.entries(spec).filter(([key]) => key !== "credentials");
    expect(others(after)).toEqual(others(before));
    const stored = await new EnvLocalFile(created.rootPath).read();
    expect(stored[RESERVED]).toBe("ghp_shell");
    expect(messages).toContain(`writing ${RESERVED} to ${ENV_LOCAL_RELATIVE_PATH}`);
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

    const messages = await drain(subject.build(reread!));

    expect(messages.filter((message) => message.includes("github"))).toEqual([]);
    expect(await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8")).toBe(
      spec,
    );
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
    const spec = await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8");

    const messages = await drain(subject.build(created));

    expect(messages).toContain(
      "not adding credential 'github' for box egress 'env://GITHUB_TOKEN': GITHUB_TOKEN is not " +
        `set here or in ${ENV_LOCAL_RELATIVE_PATH}, so deploy could not provision it. ` +
        `Set GITHUB_TOKEN, or ${RESERVED}, and build again`,
    );
    expect(await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8")).toBe(
      spec,
    );
  });

  test("says that a box profile does not parse, and changes nothing", async () => {
    const { subject } = manager({ GITHUB_TOKEN: "ghp_shell" });
    const created = await project(subject, "[egress.github\n");
    const spec = await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8");

    const messages = await drain(subject.build(created));

    expect(
      messages.some((message) =>
        message.startsWith(`skipping box egress credentials: ${BOX_PROFILE_FILE} does not parse`),
      ),
    ).toBe(true);
    expect(await readFile(join(created.rootPath, "agentcore", "agentcore.json"), "utf8")).toBe(
      spec,
    );
  });
});
