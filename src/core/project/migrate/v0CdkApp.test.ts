import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v0App, v0AppFixture, writeV0Project, type V0ProjectFiles } from "./migrate-test-support";
import { deployImpact } from "./replacements";
import {
  appBuildsHarnessContainers,
  checkCdkApp,
  resourcesOutsideV0App,
  sourceFingerprint,
} from "./v0CdkApp";
import { V0_CDK_APPS } from "./v0CdkApps";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function project(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  return root;
}

const STACK_FILE = join("agentcore", "cdk", "lib", "cdk-stack.ts");

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

describe("sourceFingerprint", () => {
  test("ignores formatting, comments, and quotes, but not code", () => {
    const source = "const a: string | undefined = 'x'; // note\nfoo(a, b);\n";
    expect(sourceFingerprint(source)).toBe(
      sourceFingerprint(
        '/* header */\nconst a:\n  | string\n  | undefined = "x"\nfoo(\n  a,\n  b,\n)\n',
      ),
    );
    expect(sourceFingerprint(source)).not.toBe(sourceFingerprint(`${source}bar();\n`));
    // A URL in a string isn't a comment.
    expect(sourceFingerprint("const u = 'https://a';")).not.toBe(
      sourceFingerprint("const u = 'https:';"),
    );
  });

  test("recognizes the apps v0 created, as `agentcore create` formatted them", () => {
    const known = (bin: string, lib: string) =>
      V0_CDK_APPS.filter(
        (app) =>
          app.files["bin/cdk.ts"] === sourceFingerprint(v0AppFixture(bin)) &&
          app.files["lib/cdk-stack.ts"] === sourceFingerprint(v0AppFixture(lib)),
      ).map((app) => app.releases);
    expect(known("cdk.ts", "cdk-stack.ts")).toEqual([
      "0.28.0 to 0.31.1 or 1.0.0-preview.28 to 1.0.0-preview.33",
    ]);
    expect(known("cdk-0.4.0.ts", "cdk-stack-0.4.0.ts")).toContain("0.4.0 to 0.9.1");
    // The previews from 3 to 9 shipped this source, with different other files.
    expect(known("cdk-1.0.0-preview.5.ts", "cdk-stack-1.0.0-preview.5.ts")).toEqual([
      "1.0.0-preview.3 to 1.0.0-preview.5",
      "1.0.0-preview.6 to 1.0.0-preview.9",
    ]);
  });
});

describe("checkCdkApp", () => {
  test("passes for an unchanged v0 app, including old releases and the 1.0.0 previews", async () => {
    expect(await checkCdkApp(await project())).toEqual({
      name: "cdk app",
      ok: true,
      message:
        "unchanged from the app v0 0.28.0 to 0.31.1 or 1.0.0-preview.28 to 1.0.0-preview.33 created",
    });
    for (const app of ["0.4.0", "1.0.0-preview.5"]) {
      const check = await checkCdkApp(await project({ app, cdkPin: "^0.1.0-alpha.1" }));
      expect(check.ok, `${app}: ${check.message}`).toBe(true);
    }
  });

  test("passes when a v0 deploy re-pinned the dependencies and npm wrote a lockfile", async () => {
    const manifest = JSON.parse(v0App("0.4.0")["package.json"]!) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    manifest.dependencies["aws-cdk-lib"] = "2.261.0";
    manifest.devDependencies["aws-cdk"] = "2.1126.0";
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
        "node_modules/aws-cdk-lib": { version: "2.261.0" },
      },
    };
    const root = await project({
      app: "0.4.0",
      files: {
        "agentcore/cdk/package.json": JSON.stringify(manifest),
        "agentcore/cdk/package-lock.json": JSON.stringify(lockfile),
        "agentcore/cdk/dist/bin/cdk.js": "// build output\n",
        "agentcore/cdk/cdk.out/tree.json": "{}\n",
      },
    });
    expect((await checkCdkApp(root)).ok).toBe(true);
  });

  test("blocks an edited source file, naming it", async () => {
    const root = await project();
    await writeFile(
      join(root, STACK_FILE),
      `${v0AppFixture("cdk-stack.ts")}\nnew s3.Bucket(this, 'Uploads');\n`,
    );
    const check = await checkCdkApp(root);
    expect(check.ok).toBe(false);
    expect(check.message).toContain("  modified  agentcore/cdk/lib/cdk-stack.ts");
    expect(check.message).toContain("compared with v0 0.28.0 to 0.31.1");
    expect(check.message).toContain("Move custom code and files out of agentcore/cdk");
    expect(check.message).toContain("If you didn't change these files");
  });

  test("blocks every file added or modified anywhere in agentcore/cdk", async () => {
    const root = await project();
    await write(root, "agentcore/cdk/lib/uploads.ts", "export const bucket = 1;\n");
    await write(root, "agentcore/cdk/notes.txt", "todo\n");
    await write(root, "agentcore/cdk/README.md", "# My app\n");
    await write(root, "agentcore/cdk/cdk.json", JSON.stringify({ app: "npx ts-node bin/cdk.ts" }));
    const check = await checkCdkApp(root);
    expect(check.ok).toBe(false);
    const listed = check.message.split("\n").filter((line) => /^ {2}(added|modified) /.test(line));
    expect(listed).toEqual([
      "  added     agentcore/cdk/lib/uploads.ts",
      "  added     agentcore/cdk/notes.txt",
      "  modified  agentcore/cdk/README.md",
      "  modified  agentcore/cdk/cdk.json",
    ]);
    // The summary names the files instead of cutting the long message off.
    expect(check.summary).toBe(
      "agentcore/cdk differs from the app v0 generated, and migrating replaces it, so these " +
        "changes would be lost: added lib/uploads.ts, added notes.txt, modified README.md, " +
        "modified cdk.json.",
    );
  });

  test("the summary names up to five changed files, then counts the rest", async () => {
    const root = await project();
    for (const n of [1, 2, 3, 4, 5, 6, 7])
      await write(root, `agentcore/cdk/lib/extra${n}.ts`, "x\n");
    const check = await checkCdkApp(root);
    expect(check.summary).toEndWith(", and 2 more.");
  });

  test("blocks a package.json with another dependency or changed scripts", async () => {
    const withDependency = await project();
    const manifest = JSON.parse(v0App("0.31.1")["package.json"]!) as Record<
      string,
      Record<string, string>
    >;
    await write(
      withDependency,
      "agentcore/cdk/package.json",
      JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, lodash: "4" } }),
    );
    expect((await checkCdkApp(withDependency)).message).toContain(
      "  modified  agentcore/cdk/package.json",
    );

    const withScript = await project();
    await write(
      withScript,
      "agentcore/cdk/package.json",
      JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, deploy: "cdk deploy" } }),
    );
    expect((await checkCdkApp(withScript)).message).toContain(
      "  modified  agentcore/cdk/package.json",
    );
  });

  test("blocks a lockfile recording a package the manifest doesn't declare", async () => {
    const root = await project({
      files: {
        "agentcore/cdk/package-lock.json": JSON.stringify({
          lockfileVersion: 3,
          packages: { "": { dependencies: { lodash: "4" } } },
        }),
      },
    });
    expect((await checkCdkApp(root)).message).toContain(
      "  modified  agentcore/cdk/package-lock.json",
    );
  });

  test("says a newer v0 release isn't recognized, from the CDK library it pinned", async () => {
    const root = await project({ cdkPin: "0.1.0-alpha.55" });
    await writeFile(join(root, STACK_FILE), "// a newer release's stack\n");
    expect((await checkCdkApp(root)).message).toBe(
      "This project's CDK app comes from a v0 CLI release newer than this CLI recognizes " +
        "(@aws/agentcore-cdk 0.1.0-alpha.55). Update the AgentCore CLI and run agentcore migrate again.",
    );
  });

  test("declares the pre-GA 0.3.0 previews unsupported", async () => {
    const root = await project({ app: "0.3.0-preview.1.0", cdkPin: "^0.1.0-alpha.1" });
    expect((await checkCdkApp(root)).message).toStartWith(
      "This project was created by a 0.3.0-preview release, which agentcore migrate doesn't support.",
    );
  });

  test("fails when a source file is missing", async () => {
    const root = await project();
    await rm(join(root, STACK_FILE));
    expect((await checkCdkApp(root)).message).toBe(
      "Couldn't read the CDK app: agentcore/cdk/lib/cdk-stack.ts is missing.",
    );
  });

  test("the documented way to keep a resource passes: retain, deploy with v0, undo, migrate", async () => {
    // 1. The user adds a removal policy to the v0 app: the app no longer matches.
    const root = await project();
    const original = v0AppFixture("cdk-stack.ts");
    await writeFile(
      join(root, STACK_FILE),
      original.replace(
        "super(scope, id, props);",
        "super(scope, id, props);\n    // keep the bucket\n    this.node.findChild('Uploads');",
      ),
    );
    expect((await checkCdkApp(root)).ok).toBe(false);
    // 2. (deploy with the v0 CLI, which writes Retain into the deployed template)
    // 3. They undo the change: the app matches again.
    await writeFile(join(root, STACK_FILE), original);
    expect((await checkCdkApp(root)).ok).toBe(true);
    // 4. migrate reads retention from the deployed template, so dropping it isn't a blocker.
    const impact = await deployImpact(
      { Resources: { Uploads: { Type: "AWS::S3::Bucket", DeletionPolicy: "Retain" } } },
      { Resources: {} },
    );
    expect(impact.removed).toMatchObject([{ logicalId: "Uploads", severity: "info" }]);
  });
});

describe("appBuildsHarnessContainers", () => {
  test("is true for apps that pass hasDockerfile (v0.16.0 and later), false before", async () => {
    expect(await appBuildsHarnessContainers(await project())).toBe(true);
    const old = await project({ app: "0.4.0" });
    expect(await appBuildsHarnessContainers(old)).toBe(false);
  });
});

describe("resourcesOutsideV0App", () => {
  const at = (path: string, Type = "AWS::IAM::Role") => ({
    Type,
    Metadata: { "aws:cdk:path": `AgentCore-P-default/${path}` },
  });

  test("flags resources under constructs the v0 stack doesn't define", () => {
    expect(
      resourcesOutsideV0App({
        Resources: {
          Runtime: at("Application/AgentA/Runtime/Resource", "AWS::BedrockAgentCore::Runtime"),
          Gateway: at("Mcp/GatewayG/Resource", "AWS::BedrockAgentCore::Gateway"),
          Payment: at("PaymentPm/Resource", "AWS::BedrockAgentCore::PaymentManager"),
          Meta: at("CDKMetadata/Default", "AWS::CDK::Metadata"),
          Provider: at("AWSCDKCfnUtilsProviderCustomResourceProvider/Role"),
          Unannotated: { Type: "AWS::SNS::Topic" },
          Uploads: at("Uploads/Resource", "AWS::S3::Bucket"),
        },
      }),
    ).toEqual(["Uploads (AWS::S3::Bucket, AgentCore-P-default/Uploads/Resource)"]);
  });

  test("accepts the container build project the v0 library adds at the stack root", () => {
    expect(
      resourcesOutsideV0App({
        Resources: {
          Project: at("ContainerBuildProject/Project/Resource", "AWS::CodeBuild::Project"),
          Role: at("ContainerBuildProject/ContainerBuildExecutionRole/Resource"),
          // A VPC build's project, suffixed with the 8-hex network hash.
          VpcProject: at(
            "ContainerBuildProject-1a2b3c4d/Project/Resource",
            "AWS::CodeBuild::Project",
          ),
          Other: at("ContainerBuildProjectX/Resource", "AWS::CodeBuild::Project"),
        },
      }),
    ).toEqual([
      "Other (AWS::CodeBuild::Project, AgentCore-P-default/ContainerBuildProjectX/Resource)",
    ]);
  });
});
