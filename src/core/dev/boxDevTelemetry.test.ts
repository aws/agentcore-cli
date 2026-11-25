import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { renderBoxProfile } from "../project/templates/boxProfile";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import {
  boxDevAgentOtelEnv,
  boxDevProfileFolder,
  boxDevTelemetryProfile,
  boxDevTelemetryTargetName,
} from "./boxDevTelemetry";

// biome-ignore lint/suspicious/noExplicitAny: a parsed TOML document
type Doc = Record<string, any>;

describe("boxDevTelemetryProfile", () => {
  test("adds an otlp target to the collector for traces and logs, with no secret", () => {
    const { text } = boxDevTelemetryProfile('[agent]\ncommand = ["x"]\n', {
      destination: "http://127.0.0.1:4318",
      serviceName: "agent",
    });

    const dev = parse(text) as Doc;
    expect(dev.telemetry.agentcore_dev).toEqual({
      kind: "otlp",
      destination: "http://127.0.0.1:4318",
      accepts: ["traces", "logs"],
      include: ["deny", "permit", "trace", "logs"],
    });
    expect(dev.telemetry.agentcore_dev.secret).toBeUndefined();
  });

  test("keeps the user's telemetry targets and does not reuse their names", () => {
    const profile =
      '[telemetry.agentcore_dev]\nkind = "file"\ndestination = "~/mine.jsonl"\n' +
      '[telemetry.logs]\nkind = "file"\ndestination = "~/logs.jsonl"\n';

    const dev = parse(
      boxDevTelemetryProfile(profile, { destination: "http://127.0.0.1:1", serviceName: "agent" })
        .text,
    ) as Doc;

    expect(Object.keys(dev.telemetry).sort()).toEqual(["agentcore_dev", "agentcore_dev_2", "logs"]);
    expect(dev.telemetry.agentcore_dev.kind).toBe("file");
    expect(dev.telemetry.agentcore_dev_2.kind).toBe("otlp");
    expect(boxDevTelemetryTargetName({ agentcore_dev: {}, agentcore_dev_2: {} })).toBe(
      "agentcore_dev_3",
    );
  });

  test("gives the agent dev's OTEL variables except the OTLP endpoints, which box sets", () => {
    const dev = parse(
      boxDevTelemetryProfile("", { destination: "http://127.0.0.1:1", serviceName: "agent" }).text,
    ) as Doc;

    expect(dev.agent.env).toEqual(boxDevAgentOtelEnv("agent"));
    expect(Object.keys(dev.agent.env).some((name) => name.startsWith("OTEL_EXPORTER_OTLP"))).toBe(
      false,
    );
  });

  test("puts the auto-instrumentation folder first on PYTHONPATH and keeps the command and its reload", () => {
    const runtime = resolveRuntimeTemplateShortcut("agent-python-strands-box", {
      runtimeName: "agent",
    });
    const local = renderBoxProfile("Demo", runtime, "us-west-2")!;

    const dev = parse(
      boxDevTelemetryProfile(local, {
        destination: "http://127.0.0.1:1",
        serviceName: "agent",
        sitecustomizeDir: "/venv/otel",
      }).text,
    ) as Doc;

    expect(dev.agent.env.PYTHONPATH).toBe("/venv/otel");
    expect(dev.agent.command).toEqual((parse(local) as Doc).agent.command);
    expect(dev.agent.command).toContain("--reload");
  });

  test("starts the venv's Python under opentelemetry-instrument without reload for a container", () => {
    const profile =
      '[agent]\ncommand = ["${{ workspace }}/.venv/bin/python", "-m", "uvicorn", "main:app", ' +
      '"--reload", "--reload-dir", "${{ workspace }}", "--port", "8081"]\n';

    const dev = boxDevTelemetryProfile(profile, {
      destination: "http://host.docker.internal:1",
      serviceName: "agent",
      instrumentCommand: true,
    });

    expect(dev.agentInstrumented).toBe(true);
    expect((parse(dev.text) as Doc).agent.command).toEqual([
      "${{ workspace }}/.venv/bin/opentelemetry-instrument",
      "${{ workspace }}/.venv/bin/python",
      "-m",
      "uvicorn",
      "main:app",
      "--port",
      "8081",
    ]);
  });

  test("leaves a command that is not the venv's Python alone, and says so", () => {
    const dev = boxDevTelemetryProfile('[agent]\ncommand = ["node", "server.js"]\n', {
      destination: "http://host.docker.internal:1",
      serviceName: "agent",
      instrumentCommand: true,
    });

    expect(dev.agentInstrumented).toBe(false);
    expect((parse(dev.text) as Doc).agent.command).toEqual(["node", "server.js"]);
  });

  test("writes into the git-ignored CLI folder of the project", () => {
    expect(boxDevProfileFolder("agent")).toBe("agentcore/.cli/box-dev/agent");
  });
});
