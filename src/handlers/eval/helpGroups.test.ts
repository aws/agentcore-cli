import { test, expect, describe } from "bun:test";
import type { Handler } from "../../router";
import { createRootHandler } from "../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../testing";
import { TestGlobalConfigAccessor } from "../../testing/";
import { HELP_GROUP } from "./helpGroups";

// The router proves that a Flag.group renders as a `--help` heading in
// declaration order (see router/router.test.ts). What these commands need
// proving instead is that they all speak the shared vocabulary: a flag left
// ungrouped falls into a leftover "Options:" block, and a hand-typed heading
// that drifts by a character silently splits into a second one. Both read as
// bugs, and neither fails any behavioral test.

const HEADINGS = new Set<string>(Object.values(HELP_GROUP));

// The eval commands converted to grouped help, by path from the root.
const GROUPED_COMMANDS = [
  ["eval", "batch-evaluation", "evaluate"],
  ["eval", "batch-evaluation", "simulate"],
  ["eval", "batch-insights", "run"],
  ["eval", "online-eval", "create"],
  ["eval", "online-eval", "update"],
] as const;

// Commands that carry worked examples in `--help`. `batch-insights run` groups
// its flags but has no examples yet, so it is deliberately absent.
const COMMANDS_WITH_EXAMPLES = [
  ["eval", "batch-evaluation", "evaluate"],
  ["eval", "batch-evaluation", "simulate"],
  ["eval", "online-eval", "create"],
  ["eval", "online-eval", "update"],
] as const;

function resolve(path: readonly string[]): Handler {
  const io = testIO();
  let node: Handler = createRootHandler(new TestCoreClient(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  for (const name of path) {
    const child = node.children().find((c) => c.name() === name);
    if (!child) throw new Error(`no '${name}' under '${node.name()}'`);
    node = child;
  }
  return node;
}

describe("eval help groups", () => {
  for (const path of GROUPED_COMMANDS) {
    const label = path.join(" ");

    test(`${label} groups every flag under a heading from the shared vocabulary`, () => {
      const flags = resolve(path).flags();
      expect(flags.length).toBeGreaterThan(0);

      const ungrouped = flags.filter((f) => !f.group).map((f) => f.name);
      expect(ungrouped).toEqual([]);

      const unknown = flags.map((f) => f.group!).filter((g) => !HEADINGS.has(g));
      expect(unknown).toEqual([]);
    });

    test(`${label} declares each heading's flags contiguously`, () => {
      // Commander orders headings by the first flag declared in each, so a flag
      // declared away from its heading-mates would render under the heading but
      // reorder the headings themselves.
      const groups = resolve(path)
        .flags()
        .map((f) => f.group!);
      const firstSeen = [...new Set(groups)];
      expect(groups).toEqual(firstSeen.flatMap((g) => groups.filter((x) => x === g)));
    });
  }

  for (const path of COMMANDS_WITH_EXAMPLES) {
    const label = path.join(" ");

    test(`${label} carries examples that name only flags it declares`, () => {
      const command = resolve(path);
      const examples = command.examples?.() ?? [];
      expect(examples.length).toBeGreaterThan(0);

      const declared = new Set(command.flags().map((f) => `--${f.name}`));
      for (const { description, command: invocation } of examples) {
        expect(description).not.toEndWith(":");
        const text = Array.isArray(invocation) ? invocation.join(" ") : invocation;
        expect(text).toStartWith(`agentcore ${label}`);
        // Catches an example left behind by a flag rename.
        for (const token of text.match(/--[a-z][a-z0-9-]*/g) ?? []) {
          expect(declared).toContain(token);
        }
      }
    });
  }
});
