import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectSpecSchema, type ProjectSpec } from "../../../projectSchemas/project";
import { ProjectKey } from "../../../router";
import { resolveRuntimeTemplateShortcut } from "../shortcuts";
import type { AddResourceInput, Project } from "../types";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
} from "../../../testing";
import { APP_CODE_RETAINED_NOTICE } from "./notice";

const RUNTIME = "agent_python_minimal";

const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  cleanupScreens();
  process.chdir(originalCwd);
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function drain<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

async function createProject(
  core: TestCoreClient,
  resources: AddResourceInput[] = [],
): Promise<{ project: Project; specPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-project-remove-"));
  temporaryDirectories.push(root);
  process.chdir(root);
  let project = await drain(
    core.projectManager.create({
      name: "orders",
      skipInstall: true,
      skipGit: true,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-minimal"),
    }),
  );
  for (const resource of resources) {
    project = await drain(core.projectManager.addResource(project, resource));
  }
  return { project, specPath: join(project.rootPath, "agentcore", "agentcore.json") };
}

const POLICY: AddResourceInput[] = [
  { resourceType: "policy-engine", resourceConfig: { name: "guard" } },
  {
    resourceType: "policy",
    engineName: "guard",
    resourceConfig: { name: "denyAll", statement: "permit(principal, action, resource);" },
  },
];

function render(path: string, core: TestCoreClient, project: Project) {
  return renderScreen(path, { core, withContext: (ctx) => ctx.withValue(ProjectKey, project) });
}

async function readSpec(specPath: string): Promise<ProjectSpec> {
  return ProjectSpecSchema.parse(JSON.parse(await readFile(specPath, "utf8")));
}

describe("project remove screen", () => {
  test("displays every removable resource type", async () => {
    const core = new TestCoreClient();
    // One of every removable resource type (runtime is scaffolded by createProject).
    const { project } = await createProject(core, [
      {
        resourceType: "harness",
        resourceConfig: {
          name: "assistant",
          model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
          systemPrompt: "You are terse.",
        },
      },
      {
        resourceType: "memory",
        resourceConfig: { name: "recall", eventExpiryDuration: 30, strategies: [] },
      },
      {
        resourceType: "credential",
        resourceConfig: {
          authorizerType: "PaymentCredentialProvider",
          name: "payCred",
          provider: "CoinbaseCDP",
        },
      },
      { resourceType: "config-bundle", resourceConfig: { name: "bundle", components: {} } },
      {
        resourceType: "online-eval",
        resourceConfig: {
          name: "quality",
          samplingRate: 10,
          agent: RUNTIME,
          evaluators: ["Builtin.Helpfulness"],
        },
      },
      {
        resourceType: "online-insight",
        resourceConfig: {
          name: "trends",
          samplingRate: 10,
          agent: RUNTIME,
          insights: ["Builtin.Coherence"],
        },
      },
      {
        resourceType: "evaluator",
        resourceConfig: {
          name: "judge",
          level: "SESSION",
          config: { codeBased: { managed: { codeLocation: "./evaluator" } } },
        },
      },
      {
        resourceType: "gateway",
        resourceConfig: {
          name: "tools",
          targets: [],
          authorizerType: "NONE",
          enableSemanticSearch: true,
          exceptionLevel: "NONE",
        },
      },
      {
        resourceType: "gateway-target",
        gatewayName: "tools",
        resourceConfig: {
          name: "external",
          targetType: "mcpServer",
          endpoint: "https://example.com/mcp",
        },
      },
      {
        resourceType: "gateway-target",
        gatewayName: "tools",
        resourceConfig: { name: "web", targetType: "connector", connectorId: "web-search" },
      },
      { resourceType: "policy-engine", resourceConfig: { name: "guard" } },
      {
        resourceType: "policy",
        engineName: "guard",
        resourceConfig: { name: "denyAll", statement: "permit(principal, action, resource);" },
      },
      { resourceType: "payment-manager", resourceConfig: { name: "payments" } },
      {
        resourceType: "payment-connector",
        managerName: "payments",
        resourceConfig: { name: "conn", credentialName: "payCred" },
      },
      {
        resourceType: "runtime-endpoint",
        runtimeName: RUNTIME,
        resourceConfig: { name: "prod", version: 1 },
      },
    ]);
    const r = render("/agentcore/project/remove", core, project);

    await waitForText(r.lastFrame, "choose a resource to remove from project orders");
    const frame = r.lastFrame()!;
    for (const resourceType of [
      "runtime",
      "harness",
      "memory",
      "credential",
      "config-bundle",
      "online-eval",
      "online-insight",
      "evaluator",
      "gateway",
      "gateway-target",
      "gateway-connector",
      "policy-engine",
      "policy",
      "payment-manager",
      "payment-connector",
      "runtime-endpoint",
    ]) {
      expect(frame).toContain(resourceType);
    }
    r.unmount();
  });

  test("lists the resource types the project holds plus an all option", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core, POLICY);
    const r = render("/agentcore/project/remove", core, project);

    await waitForText(r.lastFrame, "choose a resource to remove from project orders");
    const frame = r.lastFrame()!;
    expect(frame).toContain("runtime");
    expect(frame).toContain("policy-engine");
    expect(frame).toContain("policy");
    expect(frame).toContain("all");
    r.unmount();
  });

  test("resolves the project from the working directory when not pinned in context", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core);
    process.chdir(project.rootPath); // cd into the project, as a user would; no ProjectKey injected
    const r = renderScreen("/agentcore/project/remove", { core });

    await waitForText(r.lastFrame, "choose a resource to remove from project orders");
    expect(r.lastFrame()).not.toContain("No AgentCore project");
    r.unmount();
  });

  test("esc from the no-project screen returns to the project menu", async () => {
    const core = new TestCoreClient();
    const root = await mkdtemp(join(tmpdir(), "agentcore-no-project-"));
    temporaryDirectories.push(root);
    process.chdir(root);
    const r = renderScreen("/agentcore/project/remove", { core });

    await waitForText(r.lastFrame, "No AgentCore project found");
    await r.press("escape");
    await waitForText(r.lastFrame, "agentcore → project");
    r.unmount();
  });

  test("an empty project offers no resources to remove and no all option", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core);
    const { project: empty } = await core.projectManager.removeResource(project, {
      resourceType: "runtime",
      name: project.spec.runtimes[0]!.name,
    });
    const r = render("/agentcore/project/remove", core, empty);

    await waitForText(r.lastFrame, "This project has no resources to remove.");
    expect(r.lastFrame()).not.toContain("all");
    // Nothing to navigate or select here — only esc/ctrl+c are advertised.
    expect(r.lastFrame()).toContain("esc");
    expect(r.lastFrame()).not.toContain("filter");
    r.unmount();
  });

  test("an empty resource-type list advertises only esc/ctrl+c", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core); // only a scaffolded runtime, no harnesses
    const r = render("/agentcore/project/remove/harness", core, project);

    await waitForText(r.lastFrame, "This project has no harness resources.");
    expect(r.lastFrame()).toContain("esc");
    expect(r.lastFrame()).not.toContain("filter");
    r.unmount();
  });

  test("remove all on an empty project shows nothing to remove", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core);
    const { project: empty } = await core.projectManager.removeResource(project, {
      resourceType: "runtime",
      name: project.spec.runtimes[0]!.name,
    });
    const r = render("/agentcore/project/remove/all", core, empty);

    await waitForText(r.lastFrame, "This project has no resources to remove.");
    // Static message screen — only esc/ctrl+c are advertised.
    expect(r.lastFrame()).toContain("esc");
    expect(r.lastFrame()).not.toContain("filter");
    r.unmount();
  });

  test("offers remove all when spec entries still exist", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core);
    const { project: empty } = await core.projectManager.removeResource(project, {
      resourceType: "runtime",
      name: project.spec.runtimes[0]!.name,
    });
    const withKb: Project = {
      ...empty,
      spec: { ...empty.spec, knowledgeBases: [{ name: "kb" }] as ProjectSpec["knowledgeBases"] },
    };

    const picker = render("/agentcore/project/remove", core, withKb);
    await waitForText(picker.lastFrame, "choose a resource to remove from project orders");
    expect(picker.lastFrame()).toContain("all");
    picker.unmount();

    const confirm = render("/agentcore/project/remove/all", core, withKb);
    await waitForText(confirm.lastFrame, "Remove every resource from project orders?");
    expect(confirm.lastFrame()).toContain("knowledge base");
    confirm.unmount();
  });

  test("a resource list hints at paging only when it spans multiple pages", async () => {
    const core = new TestCoreClient();
    const memories: AddResourceInput[] = Array.from({ length: 11 }, (_, i) => ({
      resourceType: "memory",
      resourceConfig: { name: `mem${i}`, eventExpiryDuration: 30, strategies: [] },
    }));
    const { project } = await createProject(core, memories);

    const many = render("/agentcore/project/remove/memory", core, project);
    await waitForText(many.lastFrame, "choose a memory to remove");
    expect(many.lastFrame()).toContain("page"); // ←→/hl page hint on a paged list
    many.unmount();

    // The runtime list has a single entry, so no paging hint.
    const few = render("/agentcore/project/remove/runtime", core, project);
    await waitForText(few.lastFrame, "choose a runtime to remove");
    expect(few.lastFrame()).not.toContain("page");
    few.unmount();
  });

  test("the all row counts the sum of every resource", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core, POLICY);
    const r = render("/agentcore/project/remove", core, project);

    await waitForText(r.lastFrame, "all");
    // `all` = the sum of the listed rows: 1 runtime + 1 policy-engine + 1 policy.
    expect(r.lastFrame()).toMatch(/all\s+3/);
    r.unmount();
  });

  test("selecting a type lists that type's resources", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core);
    const r = render("/agentcore/project/remove", core, project);

    await waitForText(r.lastFrame, "runtime");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a runtime to remove");
    expect(r.lastFrame()).toContain(RUNTIME);
    r.unmount();
  });

  test("esc on the resource list returns to the resource-type list", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core);
    const r = render("/agentcore/project/remove/runtime", core, project);

    await waitForText(r.lastFrame, "choose a runtime to remove");
    await r.press("escape");
    await waitForText(r.lastFrame, "choose a resource to remove from project orders");
    r.unmount();
  });

  test("esc on the resource-type list returns to the project menu", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core);
    const r = render("/agentcore/project/remove", core, project);

    await waitForText(r.lastFrame, "choose a resource to remove from project orders");
    await r.press("escape");
    await waitForText(r.lastFrame, "agentcore → project");
    r.unmount();
  });

  test("confirming a removal deletes the resource from the spec", async () => {
    const core = new TestCoreClient();
    const { project, specPath } = await createProject(core);
    const r = render("/agentcore/project/remove/runtime/0", core, project);

    await waitForText(r.lastFrame, `Remove runtime '${RUNTIME}' from project orders?`);
    expect(r.lastFrame()).toContain("(y/N)");
    await r.write("y");
    await waitForText(r.lastFrame, "Resource removed");

    expect((await readSpec(specPath)).runtimes).toEqual([]);
    const successFrame = r.lastFrame()!.replace(/\s+/g, " ");
    expect(successFrame).toContain(APP_CODE_RETAINED_NOTICE);
    expect(successFrame).toContain("notes");
    expect(existsSync(join(project.rootPath, "app", RUNTIME))).toBe(true);
    r.unmount();
  });

  test("enter after success refreshes the list when the project is pinned in context", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core, POLICY);
    // ProjectKey is set in context (as the command wiring does): useProject uses
    // it as initialData and never refetches, so the removal must update the cache.
    const r = render("/agentcore/project/remove/runtime/0", core, project);

    await waitForText(r.lastFrame, `Remove runtime '${RUNTIME}' from project orders?`);
    await r.write("y");
    await waitForText(r.lastFrame, "Resource removed");
    await r.press("return");

    await waitFor(() => {
      const frame = r.lastFrame() ?? "";
      return (
        frame.includes("choose a resource to remove from project orders") &&
        frame.includes("policy") &&
        !frame.includes("runtime")
      );
    });
    r.unmount();
  });

  test("enter after success returns to the resource-type selector with fresh data", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core, POLICY);
    process.chdir(project.rootPath); // cwd-resolve path, so the selector refreshes from disk
    const r = renderScreen("/agentcore/project/remove/runtime/0", { core });

    await waitForText(r.lastFrame, `Remove runtime '${RUNTIME}' from project orders?`);
    await r.write("y");
    await waitForText(r.lastFrame, "Resource removed");
    await r.press("return");

    // Back on the resource-type selector, refreshed off disk: policy remains,
    // the just-removed runtime is gone.
    await waitFor(() => {
      const frame = r.lastFrame() ?? "";
      return (
        frame.includes("choose a resource to remove from project orders") &&
        frame.includes("policy") &&
        !frame.includes("runtime")
      );
    });
    r.unmount();
  });

  test("declining leaves the resource in place", async () => {
    const core = new TestCoreClient();
    const { project, specPath } = await createProject(core);
    const r = render("/agentcore/project/remove/runtime/0", core, project);

    await waitForText(r.lastFrame, `Remove runtime '${RUNTIME}' from project orders?`);
    await r.write("n");
    await waitFor(() => !(r.lastFrame() ?? "").includes(`Remove runtime '${RUNTIME}'`));

    expect((await readSpec(specPath)).runtimes.map((runtime) => runtime.name)).toEqual([RUNTIME]);
    r.unmount();
  });

  test("lists a nested resource with its parent and removes it", async () => {
    const core = new TestCoreClient();
    const { project, specPath } = await createProject(core, POLICY);
    const list = render("/agentcore/project/remove/policy", core, project);

    await waitForText(list.lastFrame, "choose a policy to remove");
    const frame = list.lastFrame()!;
    expect(frame).toContain("engine"); // parent column header
    expect(frame).toContain("guard"); // parent value
    expect(frame).toContain("denyAll"); // policy name
    list.unmount();

    const confirm = render("/agentcore/project/remove/policy/0", core, project);
    await waitForText(confirm.lastFrame, "Remove policy 'denyAll' from project orders?");
    expect(confirm.lastFrame()).toContain("guard"); // parent shown in the summary
    await confirm.write("y");
    await waitForText(confirm.lastFrame, "Resource removed");

    expect((await readSpec(specPath)).policyEngines[0]!.policies).toEqual([]);
    expect(confirm.lastFrame()).not.toContain(APP_CODE_RETAINED_NOTICE);
    confirm.unmount();
  });

  test("the remove-all summary itemizes the resource types being removed", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core, POLICY);
    const r = render("/agentcore/project/remove/all", core, project);

    await waitForText(r.lastFrame, "Remove every resource from project orders?");
    const frame = r.lastFrame()!;
    expect(frame).toContain("runtime");
    expect(frame).toContain("policy-engine");
    expect(frame).toContain("policy");
    r.unmount();
  });

  test("enter after remove-all refreshes the list when the project is pinned in context", async () => {
    const core = new TestCoreClient();
    const { project } = await createProject(core, POLICY);
    const r = render("/agentcore/project/remove/all", core, project); // ProjectKey pinned in context

    await waitForText(r.lastFrame, "Remove every resource from project orders?");
    await r.write("y");
    await waitForText(r.lastFrame, "All resources removed");
    const successFrame = r.lastFrame()!.replace(/\s+/g, " ");
    expect(successFrame).toContain(APP_CODE_RETAINED_NOTICE);
    expect(successFrame).toContain("notes");
    await r.press("return");

    // Back on the picker, refreshed from the emptied project.
    await waitForText(r.lastFrame, "This project has no resources to remove.");
    r.unmount();
  });

  test("removing all empties every resource collection", async () => {
    const core = new TestCoreClient();
    const { project, specPath } = await createProject(core, POLICY);
    const r = render("/agentcore/project/remove/all", core, project);

    await waitForText(r.lastFrame, "Remove every resource from project orders?");
    await r.write("y");
    await waitForText(r.lastFrame, "All resources removed");

    const spec = await readSpec(specPath);
    expect(spec.runtimes).toEqual([]);
    expect(spec.policyEngines).toEqual([]);
    r.unmount();
  });
});
