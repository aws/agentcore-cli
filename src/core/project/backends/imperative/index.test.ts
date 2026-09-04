import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateHarnessResponse,
  DeleteHarnessRequest,
  DeleteHarnessResponse,
  GetHarnessResponse,
  Harness,
  HarnessStatus,
  ListHarnessesResponse,
  UpdateHarnessRequest,
  UpdateHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CreateHarnessInput } from "../../../../handlers/harness/types";
import type { DeployResult, Project, ProjectEvent } from "../../../../handlers/project/types";
import { FsReadWriteJson } from "../../../../io";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { createSilentLogger } from "../../../../testing";
import { desiredExecutionPolicy, type ExecutionPolicyOptions } from "../../../executionRole";
import type { CoreOptions } from "../../../types";
import { DEPLOYED_STATE_RELATIVE_PATH, readDeployedState } from "../../deployedState";
import type { DeployBackendInput } from "../types";
import { ImperativeBackend, type HarnessCalls } from "./index";
import type { ExecutionRoleProvisioner, ExecutionRoleState } from "./types";

const TARGET = { name: "default", account: "111122223333", region: "us-east-1" } as const;
const ACCOUNT = TARGET.account;
const json = new FsReadWriteJson({ logger: createSilentLogger() });

/**
 * An in-memory control plane. Mutations put a harness into a transitional
 * status that flips to its terminal one after `pollsUntilSettled` GetHarness
 * calls, so tests exercise the WAITING loop without any clock.
 */
class FakeHarnessService implements HarnessCalls {
  readonly calls: string[] = [];
  readonly created: CreateHarnessInput[] = [];
  readonly updated: UpdateHarnessRequest[] = [];
  readonly deleted: DeleteHarnessRequest[] = [];
  readonly harnesses = new Map<string, Harness & { pollsLeft: number }>();
  pollsUntilSettled = 2;
  pageSize = 2;
  /** The status a create settles into; CREATE_FAILED for the failure test. */
  createSettlesTo: HarnessStatus = "READY";
  updateSettlesTo: HarnessStatus = "READY";
  failureReason?: string;
  private counter = 0;

  seed(name: string, status: HarnessStatus = "READY", id = `${name}-seed${++this.counter}`) {
    this.harnesses.set(id, this.harnessOf(id, name, { harnessName: name }, status, 0));
    return id;
  }

  private harnessOf(
    id: string,
    name: string,
    body: Partial<Harness>,
    status: HarnessStatus,
    pollsLeft: number,
  ): Harness & { pollsLeft: number } {
    return {
      ...body,
      harnessId: id,
      harnessName: name,
      arn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:harness/${id}`,
      status,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      pollsLeft,
    } as Harness & { pollsLeft: number };
  }

  async createHarness(input: CreateHarnessInput): Promise<CreateHarnessResponse> {
    this.calls.push("createHarness");
    this.created.push(input);
    const id = `${input.harnessName}-${++this.counter}`;
    const harness = this.harnessOf(
      id,
      input.harnessName!,
      { ...(input as Partial<Harness>) },
      "CREATING",
      this.pollsUntilSettled,
    );
    this.harnesses.set(id, harness);
    return { harness };
  }

  async updateHarness(request: UpdateHarnessRequest): Promise<UpdateHarnessResponse> {
    this.calls.push("updateHarness");
    this.updated.push(request);
    const harness = this.harnesses.get(request.harnessId!)!;
    Object.assign(harness, {
      systemPrompt: request.systemPrompt ?? harness.systemPrompt,
      status: "UPDATING",
      pollsLeft: this.pollsUntilSettled,
    });
    return { harness };
  }

  async deleteHarness(request: DeleteHarnessRequest): Promise<DeleteHarnessResponse> {
    this.calls.push("deleteHarness");
    this.deleted.push(request);
    const harness = this.harnesses.get(request.harnessId!)!;
    Object.assign(harness, { status: "DELETING", pollsLeft: this.pollsUntilSettled });
    return { harness };
  }

  async getHarness(id: string): Promise<GetHarnessResponse> {
    this.calls.push("getHarness");
    const harness = this.harnesses.get(id);
    if (!harness) throw notFound(id);
    if (harness.pollsLeft > 0) {
      harness.pollsLeft--;
      if (harness.pollsLeft === 0) this.settle(harness);
    }
    return { harness };
  }

  private settle(harness: Harness & { pollsLeft: number }): void {
    switch (harness.status) {
      case "CREATING":
        harness.status = this.createSettlesTo;
        break;
      case "UPDATING":
        harness.status = this.updateSettlesTo;
        break;
      case "DELETING":
        this.harnesses.delete(harness.harnessId!);
        return;
    }
    if (harness.status !== "READY") harness.failureReason = this.failureReason;
  }

  async listHarnesses(
    nextToken: string | undefined,
    _maxResults: number | undefined,
    _options: CoreOptions,
  ): Promise<ListHarnessesResponse> {
    this.calls.push("listHarnesses");
    const all = [...this.harnesses.values()];
    const start = nextToken ? Number(nextToken) : 0;
    const page = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined;
    return {
      harnesses: page.map(({ harnessId, harnessName, arn, status, createdAt, updatedAt }) => ({
        harnessId,
        harnessName,
        arn,
        status,
        createdAt,
        updatedAt,
      })),
      nextToken: next,
    };
  }

  countOf(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }
}

function notFound(id: string): Error {
  const error = new Error(`Harness ${id} not found`);
  error.name = "ResourceNotFoundException";
  return error;
}

class FakeRoles implements ExecutionRoleProvisioner {
  readonly roles = new Map<string, ExecutionRoleState>();
  readonly calls: string[] = [];

  async describe(harnessName: string): Promise<ExecutionRoleState | undefined> {
    this.calls.push(`describe:${harnessName}`);
    return this.roles.get(harnessName);
  }

  readonly ensureOptions: ExecutionPolicyOptions[] = [];

  async ensure(
    harnessName: string,
    region: string,
    options: ExecutionPolicyOptions = {},
  ): Promise<string> {
    this.calls.push(`ensure:${harnessName}`);
    this.ensureOptions.push(options);
    const roleArn = `arn:aws:iam::${ACCOUNT}:role/AgentCoreHarness-${harnessName}`;
    this.roles.set(harnessName, {
      roleArn,
      policyDocument: JSON.stringify(desiredExecutionPolicy(region, ACCOUNT, harnessName, options)),
    });
    return roleArn;
  }
}

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type HarnessFiles = { name: string; spec?: Record<string, unknown>; prompt?: string };

async function project(harnesses: HarnessFiles[]): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-imperative-"));
  tempDirectories.push(rootPath);
  await mkdir(join(rootPath, "agentcore"), { recursive: true });
  for (const harness of harnesses) await writeHarness(rootPath, harness);
  const spec = ProjectSpecSchema.parse({
    name: "example",
    version: 1,
    harnesses: harnesses.map(({ name }) => ({ name, path: `app/${name}` })),
  });
  await writeFile(join(rootPath, "agentcore", "agentcore.json"), JSON.stringify(spec));
  return { name: "example", rootPath, spec };
}

async function writeHarness(rootPath: string, { name, spec, prompt }: HarnessFiles) {
  const dir = join(rootPath, "app", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "harness.json"),
    JSON.stringify({ name, model: { provider: "bedrock", modelId: "m" }, ...spec }),
  );
  await writeFile(join(dir, "system-prompt.md"), prompt ?? "Be helpful.\n");
}

/** Re-reads the project after its spec was edited on disk. */
async function reloadSpec(project: Project, harnessNames: string[]): Promise<Project> {
  const spec = ProjectSpecSchema.parse({
    name: "example",
    version: 1,
    harnesses: harnessNames.map((name) => ({ name, path: `app/${name}` })),
  });
  await writeFile(join(project.rootPath, "agentcore", "agentcore.json"), JSON.stringify(spec));
  return { ...project, spec };
}

function subject(options: { account?: string } = {}) {
  const service = new FakeHarnessService();
  const roles = new FakeRoles();
  let tokens = 0;
  const backend = new ImperativeBackend({
    logger: createSilentLogger(),
    json,
    harness: service,
    executionRoles: roles,
    resolveAccount: async () => options.account ?? ACCOUNT,
    plan: { sleep: async () => {}, pollIntervalMs: 0 },
    newClientToken: () => `token-${++tokens}`,
  });
  return { backend, service, roles };
}

function input(overrides: Partial<DeployBackendInput> = {}): DeployBackendInput {
  return { target: TARGET, confirmTeardown: async () => false, ...overrides };
}

async function deploy(
  backend: ImperativeBackend,
  project: Project,
  overrides: Partial<DeployBackendInput> = {},
): Promise<{ events: ProjectEvent[]; result: DeployResult }> {
  const events: ProjectEvent[] = [];
  const generator = backend.deploy(project, input(overrides));
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }
  return { events, result: next.value };
}

async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the deploy to fail");
}

async function recordedHarnesses(project: Project) {
  const state = await readDeployedState(json, project.rootPath);
  return state.targets[TARGET.name]?.resources?.harnesses ?? {};
}

const stepsOf = (events: ProjectEvent[]) =>
  events.filter((e) => e.type === "step").map((e) => (e as { message: string }).message);
const linesOf = (events: ProjectEvent[]) =>
  events.filter((e) => e.type === "output").map((e) => (e as { line: string }).line);

describe("ImperativeBackend.deploy", () => {
  test("first deploy provisions the role, creates the harness, and records state", async () => {
    const { backend, service, roles } = subject();
    const p = await project([{ name: "support" }]);

    const { events, result } = await deploy(backend, p);

    // Read, write, then read again to confirm the write took.
    expect(roles.calls).toEqual(["describe:support", "ensure:support", "describe:support"]);
    expect(service.created).toHaveLength(1);
    expect(service.created[0]).toMatchObject({
      harnessName: "support",
      executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/AgentCoreHarness-support`,
      systemPrompt: [{ text: "Be helpful." }],
      clientToken: "token-1",
    });
    expect(service.updated).toHaveLength(0);
    // The engine polled through CREATING to READY before finishing.
    expect(service.countOf("getHarness")).toBe(2);

    expect(stepsOf(events)).toEqual([
      `Verifying AWS account ${ACCOUNT}`,
      "Reading harness configuration",
      "Resolving harness identities",
      "harness/support/execution-role",
      "harness/support/put-harness",
    ]);
    expect(linesOf(events)).toContain("harness/support/put-harness: waiting");
    expect(linesOf(events)).toContain("harness/support/put-harness: satisfied");

    expect(result).toEqual({
      outputs: {
        "harness.support.id": "support-1",
        "harness.support.arn": `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:harness/support-1`,
      },
    });

    const state = await readDeployedState(json, p.rootPath);
    expect(state.targets.default?.deploymentMode).toBe("imperative");
    expect(state.targets.default?.resources?.harnesses?.support).toEqual({
      harnessId: "support-1",
      harnessArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:harness/support-1`,
      executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/AgentCoreHarness-support`,
      appliedRequestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("a second deploy with nothing changed issues no mutating call", async () => {
    const { backend, service, roles } = subject();
    const p = await project([{ name: "support" }]);
    await deploy(backend, p);
    const mutations = () => service.created.length + service.updated.length;
    const before = {
      mutations: mutations(),
      ensures: roles.calls.filter((c) => c.startsWith("ensure")),
      lists: service.countOf("listHarnesses"),
    };

    const { events } = await deploy(backend, p);

    expect(mutations()).toBe(before.mutations);
    expect(roles.calls.filter((c) => c.startsWith("ensure"))).toEqual(before.ensures);
    // The id came from state, so there was no lookup by name either.
    expect(service.countOf("listHarnesses")).toBe(before.lists);
    expect(linesOf(events)).toEqual([
      "harness/support/execution-role: satisfied",
      "harness/support/put-harness: satisfied",
    ]);
  });

  test("a changed system prompt issues exactly one update and re-records the hash", async () => {
    const { backend, service } = subject();
    const p = await project([{ name: "support" }]);
    await deploy(backend, p);
    const { appliedRequestHash: before } = (await recordedHarnesses(p)).support!;

    await writeFile(join(p.rootPath, "app", "support", "system-prompt.md"), "Be terse.\n");
    const { events } = await deploy(backend, p);

    expect(service.created).toHaveLength(1);
    expect(service.updated).toHaveLength(1);
    expect(service.updated[0]).toMatchObject({
      harnessId: "support-1",
      systemPrompt: [{ text: "Be terse." }],
      // The owned collections are always sent so a removed entry is removed.
      tools: [],
      skills: [],
      allowedTools: [],
      environmentVariables: {},
    });
    expect(linesOf(events)).toContain("harness/support/put-harness: issued");
    const { appliedRequestHash: after } = (await recordedHarnesses(p)).support!;
    expect(after).not.toBe(before);

    // And a third deploy is again a no-op.
    await deploy(backend, p);
    expect(service.updated).toHaveLength(1);
  });

  test("recreates a harness that was deleted out of band and records the new id", async () => {
    const { backend, service } = subject();
    const p = await project([{ name: "support" }]);
    await deploy(backend, p);
    service.harnesses.delete("support-1");

    const { result } = await deploy(backend, p);

    expect(service.created).toHaveLength(2);
    expect(service.updated).toHaveLength(0);
    expect(result.outputs["harness.support.id"]).toBe("support-2");
    expect((await recordedHarnesses(p)).support?.harnessId).toBe("support-2");
  });

  test("deletes a harness dropped from the spec and forgets it", async () => {
    const { backend, service } = subject();
    let p = await project([{ name: "support" }, { name: "billing" }]);
    await deploy(backend, p);
    expect(Object.keys(await recordedHarnesses(p)).sort()).toEqual(["billing", "support"]);

    p = await reloadSpec(p, ["support"]);
    const { events, result } = await deploy(backend, p);

    expect(service.deleted).toEqual([{ harnessId: "billing-2", clientToken: expect.any(String) }]);
    expect(service.harnesses.has("billing-2")).toBe(false);
    expect(stepsOf(events)).toContain("delete-harness/billing");
    expect(Object.keys(await recordedHarnesses(p))).toEqual(["support"]);
    expect(Object.keys(result.outputs)).toEqual(["harness.support.id", "harness.support.arn"]);
  });

  test("adopts an existing harness by name when state records nothing", async () => {
    const { backend, service } = subject();
    // Three harnesses across two pages, so adoption has to paginate.
    service.seed("other");
    service.seed("another");
    const adoptedId = service.seed("support");
    const p = await project([{ name: "support" }]);

    const { result } = await deploy(backend, p);

    expect(service.countOf("listHarnesses")).toBe(2);
    expect(service.created).toHaveLength(0);
    // An adopted harness has no known applied request, so it is updated once...
    expect(service.updated).toHaveLength(1);
    expect(service.updated[0]?.harnessId).toBe(adoptedId);
    expect(result.outputs["harness.support.id"]).toBe(adoptedId);
    expect((await recordedHarnesses(p)).support?.harnessId).toBe(adoptedId);

    // ...and from then on it is a no-op.
    await deploy(backend, p);
    expect(service.updated).toHaveLength(1);
  });

  test("refuses to adopt when several harnesses share the name", async () => {
    const { backend, service } = subject();
    service.seed("support");
    service.seed("Support");
    const p = await project([{ name: "support" }]);

    const error = await failureOf(deploy(backend, p));

    expect(error.message).toContain("Harness 'support' matches 2 harnesses in us-east-1");
    expect(service.created).toHaveLength(0);
    expect(service.updated).toHaveLength(0);
  });

  test("surfaces CREATE_FAILED with the reason and the delete hint", async () => {
    const { backend, service } = subject();
    service.createSettlesTo = "CREATE_FAILED";
    service.failureReason = "execution role cannot be assumed";
    const p = await project([{ name: "support" }]);

    const error = await failureOf(deploy(backend, p));

    expect(error.message).toContain(
      "Harness 'support' (support-1) failed to create: execution role cannot be assumed",
    );
    expect(error.message).toContain("agentcore harness delete --id support-1");
    // The created id is still recorded so the next deploy finds it rather than
    // creating a duplicate.
    expect((await recordedHarnesses(p)).support?.harnessId).toBe("support-1");
  });

  test("retries an update that ends in UPDATE_FAILED, then gives up", async () => {
    const { backend, service } = subject();
    const p = await project([{ name: "support" }]);
    await deploy(backend, p);
    service.updateSettlesTo = "UPDATE_FAILED";
    await writeFile(join(p.rootPath, "app", "support", "system-prompt.md"), "Changed.\n");

    const error = await failureOf(deploy(backend, p));

    expect(service.updated).toHaveLength(2);
    expect(error.message).toContain("expected step 'harness/support/put-harness' to have started");
  });

  test("fails on an account mismatch before any read or write", async () => {
    const { backend, service, roles } = subject({ account: "999999999999" });
    const p = await project([{ name: "support" }]);

    const error = await failureOf(deploy(backend, p));

    expect(error.message).toBe(
      `Deployment target 'default' expects AWS account ${ACCOUNT}, but the active credentials belong to 999999999999.`,
    );
    expect(service.calls).toEqual([]);
    expect(roles.calls).toEqual([]);
  });

  test("fails the preflight on unsupported fields before any AWS call", async () => {
    const { backend, service, roles } = subject();
    const p = await project([{ name: "support", spec: { dockerfile: "Dockerfile" } }]);

    const error = await failureOf(deploy(backend, p));

    expect(error.message).toContain("'dockerfile'");
    expect(service.calls).toEqual([]);
    expect(roles.calls).toEqual([]);
  });

  test("rejects harness names that differ only by case", async () => {
    const { backend, service } = subject();
    const p = await project([{ name: "support" }, { name: "Support" }]);

    const error = await failureOf(deploy(backend, p));

    expect(error.message).toContain("differ only by case");
    expect(service.calls).toEqual([]);
  });

  test("uses a user-supplied execution role as-is and never touches IAM", async () => {
    const { backend, service, roles } = subject();
    const p = await project([
      { name: "support", spec: { executionRoleArn: "arn:aws:iam::111122223333:role/mine" } },
    ]);

    const { events } = await deploy(backend, p);

    expect(roles.calls).toEqual([]);
    expect(stepsOf(events)).not.toContain("harness/support/execution-role");
    expect(service.created[0]?.executionRoleArn).toBe("arn:aws:iam::111122223333:role/mine");
    expect((await recordedHarnesses(p)).support?.executionRoleArn).toBe(
      "arn:aws:iam::111122223333:role/mine",
    );
  });

  test("widens the role's memory grant for a harness with managed memory", async () => {
    const { backend, roles, service } = subject();
    const p = await project([{ name: "support", spec: { memory: { mode: "managed" } } }]);

    await deploy(backend, p);

    expect(roles.ensureOptions).toEqual([{ managedMemory: true }]);
    expect(service.created[0]?.memory).toEqual({ managedMemoryConfiguration: {} });
    // Unchanged on redeploy: the desired document includes the widened grant.
    await deploy(backend, p);
    expect(roles.ensureOptions).toHaveLength(1);
  });

  test("refreshes the role policy when it drifted from the desired document", async () => {
    const { backend, roles, service } = subject();
    const p = await project([{ name: "support" }]);
    await deploy(backend, p);
    roles.roles.set("support", {
      roleArn: roles.roles.get("support")!.roleArn,
      policyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
    });

    await deploy(backend, p);

    expect(roles.calls.filter((c) => c === "ensure:support")).toHaveLength(2);
    // The harness itself was unchanged, so it was left alone.
    expect(service.updated).toHaveLength(0);
  });

  test("records what a failed deploy created so the next deploy resumes from it", async () => {
    const { backend, service } = subject();
    const p = await project([{ name: "support" }, { name: "billing" }]);
    // billing's create is fine; support's fails to settle.
    service.createSettlesTo = "READY";
    const original = service.createHarness.bind(service);
    service.createHarness = async (request) => {
      if (request.harnessName === "support") throw new Error("ThrottlingException");
      return original(request);
    };

    const error = await failureOf(deploy(backend, p));

    expect(error.message).toContain("harness/support/put-harness: ThrottlingException");
    const recorded = await recordedHarnesses(p);
    expect(recorded.billing?.harnessId).toBe("billing-1");
    expect(recorded.support).toBeUndefined();
  });
});

describe("ImperativeBackend teardown", () => {
  test("refuses when nothing is recorded to remove", async () => {
    const { backend } = subject();
    const p = await project([]);

    const error = await failureOf(deploy(backend, p));

    expect(error.message).toContain("declares no resources to deploy, and no harness is recorded");
  });

  test("asks before removing and refuses when declined", async () => {
    const { backend, service } = subject();
    let p = await project([{ name: "support" }]);
    await deploy(backend, p);
    p = await reloadSpec(p, []);
    const requests: unknown[] = [];

    const error = await failureOf(
      deploy(backend, p, {
        confirmTeardown: async (request) => {
          requests.push(request);
          return false;
        },
      }),
    );

    expect(requests).toEqual([
      {
        projectName: "example",
        targetName: "default",
        resourceDescription: "harness 'support'",
        account: ACCOUNT,
        region: "us-east-1",
      },
    ]);
    expect(error.message).toContain("Re-run with --yes");
    expect(service.deleted).toHaveLength(0);
    expect((await recordedHarnesses(p)).support).toBeDefined();
  });

  test("removes every recorded harness and the target's state when confirmed", async () => {
    const { backend, service } = subject();
    let p = await project([{ name: "support" }, { name: "billing" }]);
    await deploy(backend, p);
    p = await reloadSpec(p, []);

    const { events, result } = await deploy(backend, p, { confirmTeardown: async () => true });

    expect(result).toEqual({ outputs: {}, tornDown: true });
    expect(service.deleted.map((d) => d.harnessId).sort()).toEqual(["billing-2", "support-1"]);
    expect(service.harnesses.size).toBe(0);
    expect(stepsOf(events)).toEqual(
      expect.arrayContaining(["delete-harness/support", "delete-harness/billing"]),
    );
    const state = await readDeployedState(json, p.rootPath);
    expect(state.targets.default).toBeUndefined();
    expect(await Bun.file(join(p.rootPath, DEPLOYED_STATE_RELATIVE_PATH)).exists()).toBe(true);
  });
});

describe("ImperativeBackend resolvers", () => {
  test("resolveProjectResources reports deployed and local-only harnesses", async () => {
    const { backend, service } = subject();
    let p = await project([{ name: "support" }]);
    await deploy(backend, p);
    await writeHarness(p.rootPath, { name: "billing" });
    p = await reloadSpec(p, ["support", "billing"]);

    expect(await backend.resolveProjectResources(p, { target: TARGET })).toEqual([
      { resourceType: "harness", name: "support", deploymentState: "deployed", id: "support-1" },
      { resourceType: "harness", name: "billing", deploymentState: "local-only" },
    ]);

    // A recorded harness that no longer exists on the service is local-only too.
    service.harnesses.delete("support-1");
    expect(await backend.resolveProjectResources(p, { target: TARGET })).toEqual([
      { resourceType: "harness", name: "support", deploymentState: "local-only" },
      { resourceType: "harness", name: "billing", deploymentState: "local-only" },
    ]);
  });

  test("resolveDeployedResources lists only harnesses present on the service", async () => {
    const { backend, service } = subject();
    let p = await project([{ name: "support" }, { name: "billing" }]);
    await deploy(backend, p);
    service.harnesses.delete("billing-2");
    p = await reloadSpec(p, ["support", "billing"]);

    expect(await backend.resolveDeployedResources(p, { target: TARGET })).toEqual([
      { resourceType: "harness", name: "support", id: "support-1", target: TARGET },
    ]);
  });

  test("resolveDeployedResources fails when the target was never deployed", async () => {
    const { backend } = subject();
    const p = await project([{ name: "support" }]);

    await expect(backend.resolveDeployedResources(p, { target: TARGET })).rejects.toThrow(
      "Project 'example' is not deployed to target 'default'",
    );
  });

  test("build has nothing to do", async () => {
    const { backend } = subject();
    const events: ProjectEvent[] = [];
    for await (const event of backend.build()) events.push(event);
    expect(events).toEqual([
      { type: "step", message: "Nothing to build: imperative deploy calls the service directly" },
    ]);
  });
});
