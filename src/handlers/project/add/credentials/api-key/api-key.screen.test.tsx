import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupScreens,
  createSilentLogger,
  flatFrame,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  waitFor,
  waitForText,
} from "../../../../../testing";
import { InputValidationError, SourceResolutionError } from "../../../../../errors";
import type { AppIO } from "../../../../../io";
import { createRootHandler } from "../../../../index";
import { createGatewayProjectTestHarness } from "../../gateway-test-support";

const { cleanup, inProject, projectSpec, run } = createGatewayProjectTestHarness(
  "add-api-key-credential-wizard",
);

afterEach(cleanup);
afterEach(cleanupScreens);

async function nameCredential(screen: ReturnType<typeof renderScreen>, name = "service-key") {
  await waitForText(screen.lastFrame, "what should this credential provider be called?");
  await screen.write(name);
  await screen.press("return");
  await waitForText(screen.lastFrame, "where is the key?");
}

describe("project add credentials api-key wizard", () => {
  test("reads a local file without ever rendering the key", async () => {
    const projectRoot = await inProject();
    const keyPath = join(projectRoot, "service-key.txt");
    const secret = "sk-never-render-this-value";
    await writeFile(keyPath, `${secret}\n`);
    const screen = renderScreen("/agentcore/add/credentials/api-key");

    await nameCredential(screen);
    expect(screen.lastFrame()).toContain("❯ ● in a local file");
    expect(screen.lastFrame()).not.toContain(secret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "which file holds the key?");
    expect(screen.lastFrame()).toContain("the contents are never shown");
    await screen.write(keyPath);
    expect(screen.lastFrame()).not.toContain(secret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("credential service-key");
    expect(review).toContain("source local file");
    expect(review.replaceAll(" ", "")).toContain(keyPath);
    expect(review).not.toContain(secret);
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'service-key' to 'TestProject'");
    expect(screen.lastFrame()).not.toContain(secret);
    expect((await projectSpec(projectRoot)).credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "service-key" },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain(`AGENTCORE_CREDENTIAL_SERVICE_KEY='${secret}'`);

    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "add AgentCore Identity credential providers to the current project",
    );
    screen.unmount();
  }, 15000);

  test("records a Secrets Manager reference without creating an environment entry", async () => {
    const projectRoot = await inProject();
    const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:service-key";
    const screen = renderScreen("/agentcore/add/credentials/api-key");

    await nameCredential(screen, "external-key");
    await screen.press("down");
    await waitForText(screen.lastFrame, "❯ ● already in Secrets Manager");
    await screen.press("return");

    await waitForText(screen.lastFrame, "which secret?");
    await screen.write(secretArn);
    await screen.press("return");
    await screen.write("apiKey");
    await screen.press("return");

    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    const review = flatFrame(screen.lastFrame);
    expect(review).toContain("credential external-key");
    expect(review).toContain("source Secrets Manager");
    expect(review).toContain(`secret ARN ${secretArn}`);
    expect(review).toContain("JSON key apiKey");
    await screen.press("return");

    await waitForText(screen.lastFrame, "added credential 'external-key'");
    expect((await projectSpec(projectRoot)).credentials).toEqual([
      {
        authorizerType: "ApiKeyCredentialProvider",
        name: "external-key",
        secretRef: { secretId: secretArn, jsonKey: "apiKey" },
      },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_EXTERNAL_KEY");
    screen.unmount();
  }, 15000);

  test("requires an existing readable file before advancing", async () => {
    const projectRoot = await inProject();
    const screen = renderScreen("/agentcore/add/credentials/api-key");

    await nameCredential(screen);
    await screen.press("return");
    await waitForText(screen.lastFrame, "which file holds the key?");

    await screen.press("return");
    await waitForText(screen.lastFrame, "API key file is required");

    await screen.write(join(projectRoot, "missing.txt"));
    await screen.press("return");
    await waitForText(screen.lastFrame, "no readable file at");
    expect(screen.lastFrame()).toContain("which file holds the key?");
    expect(screen.lastFrame()).not.toContain("this credential will be added");
    screen.unmount();
  });

  test("requires both parts of a Secrets Manager reference", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/api-key");

    await nameCredential(screen);
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "which secret?");

    await screen.press("return");
    await waitForText(screen.lastFrame, "Secret ARN is required");
    await screen.write("arn:aws:secretsmanager:us-west-2:123456789012:secret:key");
    await screen.press("return");
    await screen.press("return");
    await waitForText(screen.lastFrame, "JSON key is required");
    expect(screen.lastFrame()).not.toContain("this credential will be added");
    screen.unmount();
  });

  test("validates the credential name live", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/api-key");

    await waitForText(screen.lastFrame, "what should this credential provider be called?");
    await screen.write("bad name");

    await waitForText(screen.lastFrame, "Must contain only alphanumeric characters");
    screen.unmount();
  });

  test("a rejected add reports itself and hands the review back", async () => {
    const projectRoot = await inProject();
    const firstPath = join(projectRoot, "first.txt");
    const secondPath = join(projectRoot, "second.txt");
    await writeFile(firstPath, "first");
    await writeFile(secondPath, "second");
    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "duplicate",
      "--api-key",
      `file://${firstPath}`,
    ]);
    const screen = renderScreen("/agentcore/add/credentials/api-key");

    await nameCredential(screen, "duplicate");
    await screen.press("return");
    await screen.write(secondPath);
    await screen.press("return");
    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    await screen.press("return");

    await waitForText(screen.lastFrame, "same environment variable");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "this credential will be added to agentcore.json");
    expect(flatFrame(screen.lastFrame)).toContain("credential duplicate");
    expect((await projectSpec(projectRoot)).credentials).toHaveLength(1);
    screen.unmount();
  }, 15000);

  test("esc on the first step returns to the credentials menu", async () => {
    await inProject();
    const screen = renderScreen("/agentcore/add/credentials/api-key");

    await waitForText(screen.lastFrame, "what should this credential provider be called?");
    await screen.press("escape");

    await waitForText(
      screen.lastFrame,
      "add AgentCore Identity credential providers to the current project",
    );
    screen.unmount();
  });
});

describe("project add credentials api-key dispatch", () => {
  function buildRoot(io: AppIO) {
    return createRootHandler(new TestCoreClient(), {
      io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
  }

  async function routeError(io: AppIO, args: string[]): Promise<unknown> {
    return buildRoot(io)
      .route(["node", "agentcore", "add", "credentials", "api-key", ...args])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
  }

  function expectMissingName(error: unknown) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as Error).message).toContain("required option '--name");
  }

  test("a bare command in a TTY session opens the wizard", async () => {
    await inProject();
    const { streams, stdin } = ttyTestIO();

    const outcome = buildRoot(streams.io)
      .route(["node", "agentcore", "add", "credentials", "api-key"])
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let settled = false;
    void outcome.finally(() => {
      settled = true;
    });

    await waitFor(
      () => {
        if (!settled) stdin.write("\x03");
        return settled;
      },
      5000,
      150,
    );
    expect(await outcome).toEqual({ ok: true });
    expect(streams.stderr()).not.toContain("required option");
  }, 10000);

  test.each<[string, () => AppIO, string[]]>([
    ["a bare command without a TTY", () => testIO().io, []],
    ["a user-supplied flag in a TTY", () => ttyTestIO().streams.io, ["--api-key", "-"]],
    ["--json in a TTY", () => ttyTestIO().streams.io, ["--json"]],
  ])("%s stays headless", async (_label, io, args) => {
    await inProject();

    expectMissingName(await routeError(io(), args));
  });

  test("flag-driven add still runs headless in a TTY session", async () => {
    const projectRoot = await inProject();
    const keyPath = join(projectRoot, "flag-key.txt");
    await writeFile(keyPath, "flag-secret");
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "credentials",
      "api-key",
      "--name",
      "flag-key",
      "--api-key",
      `file://${keyPath}`,
    ]);

    expect((await projectSpec(projectRoot)).credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "flag-key",
    });
  }, 10000);

  test("flag-driven Secrets Manager reference still runs headless", async () => {
    const projectRoot = await inProject();
    const secretRef = {
      secretId: "arn:aws:secretsmanager:us-west-2:123456789012:secret:flag-key",
      jsonKey: "apiKey",
    };
    const { streams } = ttyTestIO();

    await buildRoot(streams.io).route([
      "node",
      "agentcore",
      "add",
      "credentials",
      "api-key",
      "--name",
      "external-key",
      "--api-key-secret-reference",
      JSON.stringify(secretRef),
    ]);

    expect((await projectSpec(projectRoot)).credentials).toContainEqual({
      authorizerType: "ApiKeyCredentialProvider",
      name: "external-key",
      secretRef,
    });
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_EXTERNAL_KEY");
  }, 10000);

  test("flag-driven inline values remain rejected instead of opening the wizard", async () => {
    const projectRoot = await inProject();
    const error = await routeError(ttyTestIO().streams.io, [
      "--name",
      "inline-key",
      "--api-key",
      "inline-secret",
    ]);

    expect(error).toBeInstanceOf(SourceResolutionError);
    expect((error as Error).message).toContain("inline secret values are not accepted");
    expect((await projectSpec(projectRoot)).credentials ?? []).toEqual([]);
  });
});
