import { expect, test } from "bun:test";

import { renderMarkdown } from "./generate-command-reference.mjs";

test("renders nested commands, arguments, options, and normalized prose", () => {
  const markdown = renderMarkdown({
    version: "1.0.0",
    groups: [
      {
        id: "project",
        title: "Project commands",
        entries: [
          {
            name: "agentcore project",
            signature: "agentcore project [options] [command]",
            summary: "manage projects",
            params: [],
            members: [
              {
                name: "agentcore project create",
                signature: "agentcore project create [options] [name]",
                summary: "create a project — from a template",
                params: [
                  {
                    name: "name",
                    required: false,
                    description: "project name",
                  },
                  {
                    name: "--template <template>",
                    required: false,
                    description: "template, e.g. agent_python",
                  },
                ],
                members: [],
              },
            ],
          },
        ],
      },
    ],
  });

  expect(markdown).toContain("## Table of contents");
  expect(markdown).toContain("- [Project commands](#project-commands)");
  expect(markdown).toContain("## Project commands");
  expect(markdown).toContain("### `agentcore project`");
  expect(markdown).toContain("#### `agentcore project create`");
  expect(markdown).toContain("- `name` (optional): project name");
  expect(markdown).toContain("- `--template <template>`: template, e.g. agent\\_python");
  expect(markdown).toContain("create a project: from a template");
  expect(markdown).not.toContain("—");
});
