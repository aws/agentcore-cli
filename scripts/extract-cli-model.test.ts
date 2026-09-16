import { describe, expect, test } from "bun:test";

import { parseHelp } from "./extract-cli-model.mjs";

describe("parseHelp", () => {
  test("parses grouped options and excludes global options", () => {
    const parsed = parseHelp(`Usage: agentcore eval ondemand evaluate [options]

evaluate existing sessions

Session source:
  --agent <agent>                  harness ID or Runtime ID
  --session-ids <session-ids...>   specific session IDs

Other options:
  -h, --help                     display help for command

Global Options:
  --region <region>              AWS region
`);

    expect(parsed.summary).toBe("evaluate existing sessions");
    expect(parsed.options.map((option) => option.name)).toEqual([
      "--agent <agent>",
      "--session-ids <session-ids...>",
      "-h, --help",
    ]);
  });

  test("parses nested commands without treating wrapped text as a command", () => {
    const parsed = parseHelp(`Usage: agentcore project [options] [command]

manage an AgentCore project

Commands:
  create                         create a new project
  export                         convert resources into editable code you
                                 own
`);

    expect(parsed.commands).toEqual(["create", "export"]);
  });

  test.each([
    { usageArgument: "<trace-id>", argument: "trace-id", required: true },
    { usageArgument: "[prompt]", argument: "prompt", required: false },
  ])("marks $usageArgument as required=$required", ({ usageArgument, argument, required }) => {
    const parsed = parseHelp(`Usage: agentcore runtime traces get ${usageArgument}

download a trace

Arguments:
  ${argument}  trace identifier
`);

    expect(parsed.args[0]?.required).toBe(required);
  });
});
