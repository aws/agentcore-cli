import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import z from "zod";
import { RUNTIME_TEMPLATE_SHORTCUTS } from "../../src/handlers/project/shortcuts";
import { CliRunner, parseResult, type RunResult } from "../helpers/run";

type ScanCase = {
  template: string;
  projectName: string;
  container: boolean;
};

type VulnerabilityException = {
  id?: unknown;
  statement?: unknown;
  expired_at?: unknown;
};

const SCAN_CASES: readonly ScanCase[] = [
  { template: "agent-python-minimal", projectName: "ScanPythonMinimal", container: false },
  { template: "agent-python-strands", projectName: "ScanPythonStrands", container: false },
  {
    template: "agent-python-strands-container",
    projectName: "ScanStrandsContainer",
    container: true,
  },
  { template: "agent-python-langchain", projectName: "ScanPythonLangchain", container: false },
  { template: "mcp-python-fastmcp", projectName: "ScanPythonFastMcp", container: false },
  { template: "a2a-python-strands", projectName: "ScanPythonA2a", container: false },
  { template: "agui-python-strands", projectName: "ScanPythonAgui", container: false },
  { template: "environment-python-bma", projectName: "ScanPythonBma", container: true },
] as const;

const ProjectCreatedSchema = z.object({
  project: z.object({ path: z.string() }),
});

const repositoryRoot = resolve(".");
const reportRoot = resolve(
  process.env.GENERATED_ARTIFACT_SECURITY_REPORT_DIR ?? "out/generated-artifact-security/reports",
);
const exceptionsPath = join(
  repositoryRoot,
  "security",
  "generated-artifact-vulnerability-exceptions.yaml",
);

function run(command: readonly string[], cwd: string): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const [executable, ...args] = command;
    if (!executable) throw new Error("cannot run an empty command");
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolveResult({ stdout, stderr, exitCode: exitCode ?? -1 }));
  });
}

async function runSuccessfully(command: readonly string[], cwd: string): Promise<RunResult> {
  const result = await run(command, cwd);
  expect(
    result.exitCode,
    `${command.join(" ")} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  ).toBe(0);
  return result;
}

async function validateExceptions(): Promise<void> {
  const document = parse(await readFile(exceptionsPath, "utf8")) as {
    vulnerabilities?: unknown;
  } | null;
  const vulnerabilities = document?.vulnerabilities;
  expect(Array.isArray(vulnerabilities)).toBe(true);
  if (!Array.isArray(vulnerabilities)) throw new Error("exceptions must be a list");

  const today = new Date().toISOString().slice(0, 10);
  for (const exception of vulnerabilities as VulnerabilityException[]) {
    expect(exception.id, "every exception must identify a vulnerability").toBeTypeOf("string");
    expect(exception.statement, `${String(exception.id)} must document its rationale`).toBeTypeOf(
      "string",
    );
    expect(
      (exception.statement as string).trim().length,
      `${String(exception.id)} must document a non-empty rationale`,
    ).toBeGreaterThan(0);
    expect(exception.expired_at, `${String(exception.id)} must have an expiration`).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(
      (exception.expired_at as string) >= today,
      `${String(exception.id)} expired on ${String(exception.expired_at)}`,
    ).toBe(true);
  }
}

describe.runIf(process.platform === "linux")("generated artifact vulnerability scanning", () => {
  const cli = new CliRunner();

  test("matrix covers every supported Python template", () => {
    const supported = Object.entries(RUNTIME_TEMPLATE_SHORTCUTS)
      .filter(([, template]) => template.language === "Python")
      .map(([name]) => name)
      .sort();
    expect(SCAN_CASES.map(({ template }) => template).sort()).toEqual(supported);
  });

  test.each(SCAN_CASES)(
    "$template",
    { timeout: 15 * 60 * 1000 },
    async ({ template, projectName, container }) => {
      await validateExceptions();
      await mkdir(reportRoot, { recursive: true });
      const parent = await mkdtemp(join(tmpdir(), "agentcore-security-e2e-"));
      try {
        const created = parseResult(
          ProjectCreatedSchema,
          await cli.run(
            [
              "create",
              "--name",
              projectName,
              "--template",
              template,
              "--skip-install",
              "--skip-git",
              "--region",
              "us-west-2",
              "--json",
            ],
            parent,
          ),
        );
        const runtimeRoot = join(created.project.path, "app", "agent");
        await runSuccessfully(["uv", "lock", "--refresh"], runtimeRoot);

        const dependencyReport = join(reportRoot, `${template}-dependencies.json`);
        await runSuccessfully(
          [
            "trivy",
            "fs",
            "--scanners",
            "vuln",
            "--severity",
            "HIGH,CRITICAL",
            "--ignore-unfixed",
            "--show-suppressed",
            "--exit-code",
            "1",
            "--format",
            "json",
            "--output",
            dependencyReport,
            "--ignorefile",
            exceptionsPath,
            runtimeRoot,
          ],
          repositoryRoot,
        );

        const metadata: Record<string, unknown> = {
          template,
          architecture: container ? "linux/arm64" : undefined,
          lockfileSha256: createHash("sha256")
            .update(await readFile(join(runtimeRoot, "uv.lock")))
            .digest("hex"),
          dependencyReport,
        };
        if (container) {
          const imageName = `agentcore-generated-scan:${template}`;
          await runSuccessfully(
            [
              "docker",
              "buildx",
              "build",
              "--platform",
              "linux/arm64",
              "--pull",
              "--no-cache",
              "--load",
              "--tag",
              imageName,
              runtimeRoot,
            ],
            repositoryRoot,
          );
          const image = await runSuccessfully(
            ["docker", "image", "inspect", "--format", "{{.Id}}", imageName],
            repositoryRoot,
          );
          const imageReport = join(reportRoot, `${template}-image.json`);
          await runSuccessfully(
            [
              "trivy",
              "image",
              "--scanners",
              "vuln",
              "--severity",
              "HIGH,CRITICAL",
              "--ignore-unfixed",
              "--show-suppressed",
              "--exit-code",
              "1",
              "--format",
              "json",
              "--output",
              imageReport,
              "--ignorefile",
              exceptionsPath,
              imageName,
            ],
            repositoryRoot,
          );
          metadata.imageDigest = image.stdout.trim();
          metadata.imageReport = imageReport;
        }
        await writeFile(
          join(reportRoot, `${template}-metadata.json`),
          `${JSON.stringify(metadata, null, 2)}\n`,
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
