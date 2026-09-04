import { describe, expect, test } from "bun:test";
import { PROJECT_TEMPLATE_NAMES } from "./shortcuts";

describe("template order", () => {
  test("groups by protocol, then language, framework, and build, with empty last", () => {
    expect(PROJECT_TEMPLATE_NAMES).toEqual([
      "agent-python-strands",
      "agent-python-strands-container",
      "agent-python-langchain",
      "agent-python-minimal",
      "agent-typescript-strands",
      "a2a-python-strands",
      "agui-python-strands",
      "mcp-python-fastmcp",
      "empty",
    ]);
  });
});
