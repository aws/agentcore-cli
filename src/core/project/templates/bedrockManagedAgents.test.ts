import { expect, test } from "bun:test";
import { parse } from "yaml";
import { FsAssetSource } from "../source";

const BMA_ASSET_DIR = "templates/bedrock-managed-agents";

test("Bedrock Managed Agents assets preserve the environment and lifecycle contract", async () => {
  const source = new FsAssetSource();
  const paths = await source.list(BMA_ASSET_DIR);
  const read = (path: string) => source.read(`${BMA_ASSET_DIR}/${path}`);
  const [
    dockerfile,
    dockerignore,
    policyText,
    pyproject,
    server,
    collectorText,
    client,
    pluginText,
    skill,
  ] = await Promise.all([
    read("Dockerfile"),
    read("dockerignore.template"),
    read("bma-acr-policy.json"),
    read("pyproject.toml"),
    read("lifecycle/server.py"),
    read("otel/collector.yaml"),
    read("client.py"),
    read("plugins/acr-report/.codex-plugin/plugin.json"),
    read("plugins/acr-report/skills/acr-report/SKILL.md"),
  ]);

  expect(paths).toEqual(
    expect.arrayContaining([
      `${BMA_ASSET_DIR}/Dockerfile`,
      `${BMA_ASSET_DIR}/dockerignore.template`,
      `${BMA_ASSET_DIR}/bma-acr-policy.json`,
      `${BMA_ASSET_DIR}/client.py`,
      `${BMA_ASSET_DIR}/lifecycle/server.py`,
      `${BMA_ASSET_DIR}/otel/collector.yaml`,
      `${BMA_ASSET_DIR}/plugins/acr-report/.codex-plugin/plugin.json`,
      `${BMA_ASSET_DIR}/plugins/acr-report/skills/acr-report/SKILL.md`,
      `${BMA_ASSET_DIR}/pyproject.toml`,
    ]),
  );

  // The image owns dependency installation and packages every lifecycle dependency.
  expect(dockerfile).toContain("FROM public.ecr.aws/lambda/microvms:al2023-minimal");
  expect(dockerfile).toContain("https://chatgpt.com/codex/install.sh");
  expect(dockerfile).toContain("amazon-cloudwatch-agent.rpm");
  expect(dockerfile).toContain("COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/");
  expect(dockerfile).toContain("RUN uv sync --no-dev");
  expect(dockerfile).toContain("COPY lifecycle/ lifecycle/");
  expect(dockerfile).toContain("COPY otel/ otel/");
  expect(dockerfile).toContain("COPY plugins/ plugins/");
  expect(dockerfile).toContain("USER app");
  expect(dockerfile).toContain(
    'CMD ["uv", "run", "--no-sync", "opentelemetry-instrument", "python", "-u", "lifecycle/server.py"]',
  );
  expect(dockerignore).toContain(".venv/");
  expect(dockerignore).toContain(".env");
  expect(dockerignore).toContain(".git/");
  expect(dockerignore).toContain(".agentcore/artifacts/");

  const policy = JSON.parse(policyText);
  expect(policy).toEqual({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AttachToBmaEnvironment",
        Effect: "Allow",
        Action: ["bedrock-mantle:RegisterEnvironment", "bedrock-mantle:ConnectEnvironment"],
        Resource: "arn:*:bedrock-mantle:*:*:project/*",
      },
    ],
  });

  const version = /^version = "([^"]+)"$/m.exec(pyproject)?.[1];
  expect(version).toBeDefined();
  expect(pyproject).toContain('"aws-opentelemetry-distro",');
  expect(pyproject).toContain('"bedrock-agentcore",');
  expect(pyproject).toContain('"aws-bedrock-token-generator>=1.1.0",');
  expect(pyproject).toContain('"openai>=3.16.2",');
  expect(pyproject).toContain("[tool.uv]\npackage = false");

  // BMA calls this protocol, and the server translates its failures into HTTP 200 bodies.
  expect(server).toContain(`BMA_VERSION = "${version}"`);
  expect(server).toContain('BMA_REMOTE_SERVICE = "bedrock-mantle"');
  expect(server).toContain("PROTOCOL_VERSION = 1");
  expect(server).toContain('"activate": self.activate');
  expect(server).toContain('"renew_turn_lease": self.renew_turn_lease');
  expect(server).toContain('"release_turn_lease": self.release_turn_lease');
  expect(server).toContain('"disconnect": lambda _: self.disconnect()');
  expect(server).toContain('if self.path == "/ping":');
  expect(server).toContain('if self.path != "/invocations":');
  expect(server).toContain("self.send_response(HTTPStatus.OK)");
  expect(server).toContain('"status_code": int(status)');
  expect(server).toContain('"workspace_directory": directory');
  expect(server).toContain('workspace = Path(attachment["workspace_directory"])');
  expect(server).toContain("cwd=workspace");
  expect(server).toContain('"attachment_generation": generation');
  expect(server).toContain("accepted = min(duration, BMA_MAX_TURN_LEASE)");
  expect(server).toContain('temporary = directory / "state.json.tmp"');
  expect(server).toContain('temporary.replace(directory / "state.json")');
  expect(server).toContain(
    'runtime_session_id = self.headers.get(\n            "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"',
  );
  expect(server).toContain("threading.Thread(target=LIFECYCLE.monitor, daemon=True).start()");
  expect(server).toContain('ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()');

  // The exec-server exports locally; the collector adds the Runtime session and signs AWS exports.
  expect(server).toContain('COLLECTOR_ENDPOINT = "http://127.0.0.1:4318"');
  expect(server).toContain("*(TELEMETRY_OVERRIDES if self._ensure_collector_locked() else [])");
  expect(server).toContain('"AGENTCORE_RUNTIME_SID": self.runtime_session_id');
  const collector = parse(collectorText);
  expect(collector).toMatchObject({
    receivers: {
      otlp: {
        protocols: {
          http: { endpoint: "127.0.0.1:4318", include_metadata: true },
        },
      },
    },
    processors: {
      attributes: {
        actions: [{ key: "session.id", value: "${env:AGENTCORE_RUNTIME_SID}", action: "upsert" }],
      },
    },
    extensions: {
      "sigv4auth/xray": { region: "${env:AWS_REGION}", service: "xray" },
      "sigv4auth/logs": { region: "${env:AWS_REGION}", service: "logs" },
      "headers_setter/traces": { additional_auth: "sigv4auth/xray" },
      "headers_setter/logs": { additional_auth: "sigv4auth/logs" },
    },
    service: {
      pipelines: {
        traces: { receivers: ["otlp"], processors: ["attributes"], exporters: ["otlphttp/traces"] },
        logs: { receivers: ["otlp"], processors: ["attributes"], exporters: ["otlphttp/logs"] },
      },
    },
  });
  expect(collectorText).toContain("from_context: x-aws-log-group");
  expect(collectorText).toContain("from_context: x-aws-log-stream");

  // The sample client must address Mantle in the Runtime region and request the ACR environment.
  expect(client).toContain('region = args.runtime.split(":")[3]');
  expect(client).toContain("api_key=lambda: provide_token(region=region)");
  expect(client).toContain('base_url=f"https://bedrock-mantle.{region}.api.aws/openai/v1"');
  expect(client).toContain('WORKSPACE_DIRECTORY = "/home/app/workspace"');
  expect(client).toContain('CAPABILITY_DIRECTORIES = ["/opt/bma/plugins"]');
  expect(client).toContain('"type": "aws_bedrock_agentcore"');
  expect(client).toContain('"runtime_qualifier": "DEFAULT"');
  expect(client).toContain('"workspace_directory": WORKSPACE_DIRECTORY');
  expect(client).toContain('"capability_directories": CAPABILITY_DIRECTORIES');
  expect(client).toContain("stream=True");
  expect(client).toContain('extra_query={"stream": "true"}');

  expect(JSON.parse(pluginText)).toEqual({
    name: "acr-report",
    version: "0.1.0",
    description: "Report the Python version, user, and working directory of the ACR.",
    skills: "./skills/",
  });
  expect(skill).toContain("acr-report.txt");
  expect(skill).toContain("Python version");
  expect(skill).toContain("working directory");
});
