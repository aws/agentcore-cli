import { describe, expect, test } from "bun:test";
import { InvalidEnvironmentError } from "../../errors/errors";
import { ProcessFailedError, type ProcessEvent, type StreamProcessOptions } from "../../io";
import { BoxCliProfileResolver, parseBoxProfileShow } from "./boxProfileResolver";

const NC = 'action == Box::Action::"net:connect"';

/** `box profile show .box/profile.toml --full` of box 0.1.11, trimmed. */
const SHOWN = [
  "box / profile .box/profile.toml",
  "",
  "✓ Resolves for this directory",
  "  packs     box/base 1, box/bedrock 1",
  "  ! route github: api.github.com (no credential, open to every program in the box)",
  "",
  "# box.toml",
  'name = "L3NoAuth-preview"',
  "",
  "[egress.bedrock]",
  'destinations = ["bedrock-runtime.us-west-2.amazonaws.com"]',
  "",
  "# policy.dw",
  "// No admin paths on GitHub.",
  `@id("route_github_connect") permit (principal, ${NC}, resource) when { (context.input.host == "api.github.com" && context.input.port == 443) };`,
  "",
].join("\n");

describe("parseBoxProfileShow", () => {
  test("takes the box.toml and the policy.dw that box prints after its summary", () => {
    expect(parseBoxProfileShow(SHOWN)).toEqual({
      boxToml:
        'name = "L3NoAuth-preview"\n\n[egress.bedrock]\ndestinations = ["bedrock-runtime.us-west-2.amazonaws.com"]\n',
      policy:
        "// No admin paths on GitHub.\n" +
        `@id("route_github_connect") permit (principal, ${NC}, resource) when { (context.input.host == "api.github.com" && context.input.port == 443) };\n`,
    });
  });

  test("finds no sections in the summary that `show` prints without --full", () => {
    expect(
      parseBoxProfileShow(
        "box / profile .box/profile.toml\n\nFull configuration: box profile show .box/profile.toml --full\n",
      ),
    ).toBeUndefined();
  });
});

/** A process streamer that yields `lines`, then fails with `failure` when one is given. */
function streamer(lines: ProcessEvent[], failure?: ProcessFailedError) {
  const calls: { command: string[]; options: StreamProcessOptions }[] = [];
  return {
    calls,
    async *streamProcess(command: string[], options: StreamProcessOptions) {
      calls.push({ command, options });
      yield* lines;
      if (failure) throw failure;
    },
  };
}

const stdout = (text: string): ProcessEvent[] =>
  text.split("\n").map((line) => ({ type: "stdout", line }));

describe("BoxCliProfileResolver", () => {
  test("runs `box profile show <profile> --full` in the project folder, with no colour", async () => {
    const fake = streamer(stdout(SHOWN));
    const resolver = new BoxCliProfileResolver({ env: { PATH: "/bin" }, ...fake });

    const resolved = await resolver.resolve("/work/demo", ".box/profile.toml");

    expect(resolved).toEqual(parseBoxProfileShow(SHOWN)!);
    expect(fake.calls).toEqual([
      {
        command: ["box", "profile", "show", ".box/profile.toml", "--full"],
        options: { cwd: "/work/demo", env: { PATH: "/bin", NO_COLOR: "1" } },
      },
    ]);
  });

  test("names box's own error, and not its usage text, when box refuses the profile", async () => {
    const command = ["box", "profile", "show", ".box/profile.toml", "--full"];
    const fake = streamer(
      [
        {
          type: "stderr",
          line: "box: error: /work/demo/.box/profile.toml:4: a profile holds no `policy`; list authored files in `policies`",
        },
        { type: "stderr", line: "Usage: box profile show [OPTIONS] <NAME>" },
        { type: "stderr", line: "For more information, try '--help'." },
      ],
      new ProcessFailedError(command, "/work/demo", 1, "box: error: ..."),
    );

    const error = await new BoxCliProfileResolver(fake)
      .resolve("/work/demo", ".box/profile.toml")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    expect((error as Error).message).toBe(
      "`box profile show .box/profile.toml --full` failed in /work/demo (exit code 1), so build " +
        "cannot read the box profile as Box resolves it:\n" +
        "  box: error: /work/demo/.box/profile.toml:4: a profile holds no `policy`; list authored " +
        "files in `policies`\n" +
        "Fix what box names, so that `box profile show .box/profile.toml` succeeds in the project " +
        "folder, then retry.",
    );
  });

  test("says box did not start, and where to get it, when box is not on PATH", async () => {
    const command = ["box", "profile", "show", ".box/profile.toml", "--full"];
    const fake = streamer(
      [],
      new ProcessFailedError(command, "/work/demo", null, "Error: spawn box ENOENT"),
    );

    await expect(
      new BoxCliProfileResolver(fake).resolve("/work/demo", ".box/profile.toml"),
    ).rejects.toThrow(
      new InvalidEnvironmentError(
        "build and deploy read .box/profile.toml with `box profile show .box/profile.toml " +
          "--full`, as Box resolves it, and box did not start: Error: spawn box ENOENT. Put box " +
          "on PATH, as `agentcore dev` needs it (https://github.com/mquang-amazon/box-releases), " +
          "then retry.",
      ),
    );
  });

  test("refuses the output of a box that prints no box.toml and policy.dw", async () => {
    const fake = streamer(stdout("box / profile .box/profile.toml"));

    await expect(
      new BoxCliProfileResolver(fake).resolve("/work/demo", ".box/profile.toml"),
    ).rejects.toThrow('printed no "# box.toml" and "# policy.dw" sections');
  });
});
