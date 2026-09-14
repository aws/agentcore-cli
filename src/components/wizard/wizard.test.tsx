import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import z from "zod";
import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { cleanupScreens, keys, tick, ttyTestIO, waitFor } from "../../testing";
import { AgentCoreCLIError } from "../../errors";
import { Wizard, type WizardSubmitResult } from "./Wizard";
import { Step } from "./Step";
import { ChoiceField, MultiChoiceField, Summary, TextField } from "./fields";

afterEach(cleanupScreens);

// The wizard shell is exercised through a synthetic flow rather than one of the
// real screens, so these tests describe the shell's own behaviour: how it
// derives steps from children, moves between them, and reports outcomes.

interface HarnessOptions {
  onSubmit?: () => WizardSubmitResult;
  onCancel?: () => void;
  onDone?: () => void;
}

// A schema with a shape a stray space breaks, the way a resource-name schema
// does: it is what makes "validated as typed" observable.
const NAME_SCHEMA = z.string().regex(/^[A-Za-z]+$/, "letters only");

const YES_NO = [
  { value: false, label: "no", description: "skip the extra question" },
  { value: true, label: "yes", description: "ask the extra question" },
];

// TestWizard has one conditional step, so the branch behaviour under test is
// expressed the way a screen expresses it: `{condition && <Step/>}`.
function TestWizard({ onSubmit, onCancel, onDone }: HarnessOptions) {
  const [name, setName] = useState("");
  const [wantsExtra, setWantsExtra] = useState(false);
  const [extra, setExtra] = useState("");

  return (
    <Wizard
      breadcrumb={["agentcore", "test"]}
      description="a synthetic flow"
      onCancel={onCancel ?? (() => {})}
      onSubmit={onSubmit ?? (async () => {})}
      onDone={onDone}
      runningLabel="working…"
      successLabel="all done"
      successHint="enter exits"
    >
      <Step stepKey="name" prompt="what is your name?">
        <TextField label="name" value={name} onChange={setName} required schema={NAME_SCHEMA} />
      </Step>

      <Step stepKey="branch" prompt="want the extra question?">
        <ChoiceField choices={YES_NO} value={wantsExtra} onChange={setWantsExtra} />
      </Step>

      {wantsExtra && (
        <Step stepKey="extra" prompt="the extra question">
          <TextField label="extra" value={extra} onChange={setExtra} />
        </Step>
      )}

      <Step stepKey="review" prompt="review">
        <Summary items={{ name, extra: extra === "" ? "(none)" : extra }} />
      </Step>
    </Wizard>
  );
}

interface Driver {
  lastFrame: () => string | undefined;
  write: (input: string) => Promise<void>;
  press: (key: keyof typeof keys) => Promise<void>;
  // pressTwice delivers two discrete key events in one drain, with no render in
  // between — what a fast typist produces. A single "\r\r" chunk would not do:
  // Ink reports a multi-character chunk with key.return false, so it never
  // reaches a return handler at all.
  pressTwice: (key: keyof typeof keys) => Promise<void>;
  unmount: () => void;
}

function drive(options: HarnessOptions = {}): Driver {
  const instance = render(<></>);
  Object.defineProperties(instance.stdout, {
    columns: { configurable: true, value: 100 },
    rows: { configurable: true, value: 40 },
  });
  instance.rerender(<TestWizard {...options} />);

  return {
    lastFrame: instance.lastFrame,
    write: async (input) => {
      await tick();
      instance.stdin.write(input);
      await tick();
    },
    press: async (key) => {
      await tick();
      instance.stdin.write(keys[key]);
      await tick();
    },
    pressTwice: async (key) => {
      await tick();
      instance.stdin.write(keys[key]);
      instance.stdin.write(keys[key]);
      await tick();
    },
    unmount: instance.unmount,
  };
}

function waitForFrame(driver: Driver, text: string): Promise<void> {
  return waitFor(() => (driver.lastFrame() ?? "").includes(text), 1000);
}

describe("Wizard shell", () => {
  test("derives the stepper from its Step children", async () => {
    const d = drive();

    await waitForFrame(d, "what is your name?");
    const frame = d.lastFrame()!;
    expect(frame).toContain("● name");
    expect(frame).toContain("○ branch");
    expect(frame).toContain("○ review");
    // The conditional step is not offered while its condition is false.
    expect(frame).not.toContain("○ extra");
    d.unmount();
  });

  test("a step appears mid-flow when its condition turns true", async () => {
    const d = drive();

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");

    await waitForFrame(d, "want the extra question?");
    expect(d.lastFrame()).not.toContain("○ extra");

    // Choosing "yes" inserts the step between here and review.
    await d.press("down");
    await waitForFrame(d, "○ extra");
    await d.press("return");

    await waitForFrame(d, "the extra question");
    d.unmount();
  });

  test("enter advances and esc goes back, keeping answers", async () => {
    const d = drive();

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");

    await waitForFrame(d, "want the extra question?");
    await d.press("escape");

    await waitForFrame(d, "what is your name?");
    expect(d.lastFrame()).toContain("Ada");
    d.unmount();
  });

  test("esc on the first step cancels out of the wizard", async () => {
    let cancelled = 0;
    const d = drive({ onCancel: () => cancelled++ });

    await waitForFrame(d, "what is your name?");
    await d.press("escape");

    expect(cancelled).toBe(1);
    d.unmount();
  });

  test("the footer hints come from the active field", async () => {
    const d = drive();

    // A text field offers enter; a choice field also offers the arrows.
    await waitForFrame(d, "what is your name?");
    expect(d.lastFrame()).toContain("[enter] continue");
    expect(d.lastFrame()).not.toContain("[↑↓] choose");

    await d.write("Ada");
    await d.press("return");

    await waitForFrame(d, "want the extra question?");
    expect(d.lastFrame()).toContain("[↑↓] navigate");
    d.unmount();
  });

  test("enter on the last step submits and reports success", async () => {
    let submits = 0;
    const d = drive({
      onSubmit: async () => {
        submits++;
      },
    });

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");
    await waitForFrame(d, "want the extra question?");
    await d.press("return");
    await waitForFrame(d, "review");
    expect(d.lastFrame()).toContain("[enter] submit");
    await d.press("return");

    await waitForFrame(d, "✔ all done");
    expect(submits).toBe(1);
    d.unmount();
  });

  test("a streamed submit renders its steps through the shared TaskList", async () => {
    // The pauses let Ink paint between events: a generator that runs to
    // completion in one batch would only ever produce the final frame, and the
    // tail under a running step is exactly what that frame no longer shows.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    async function* progress() {
      yield { type: "step", message: "wrote agentcore.json" } as const;
      await pause();
      yield { type: "output", line: "a line tailing the running step" } as const;
      await pause();
      yield { type: "step", message: "updated the deploy target" } as const;
    }
    const d = drive({ onSubmit: () => progress() });

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");
    await waitForFrame(d, "want the extra question?");
    await d.press("return");
    await waitForFrame(d, "review");
    await d.press("return");

    // An output line tails the step it belongs to while that step runs, and
    // collapses with it — TaskList's behaviour everywhere else in the CLI.
    await waitForFrame(d, "│ a line tailing the running step");

    await waitForFrame(d, "✔ all done");
    const frame = d.lastFrame()!;
    expect(frame).toContain("✓ wrote agentcore.json");
    expect(frame).toContain("✓ updated the deploy target");
    expect(frame).not.toContain("a line tailing the running step");
    d.unmount();
  });

  test("a buffered second enter does not submit twice", async () => {
    let submits = 0;
    const d = drive({
      onSubmit: async () => {
        submits++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");
    await waitForFrame(d, "want the extra question?");
    await d.press("return");
    await waitForFrame(d, "review");
    await d.pressTwice("return");

    await waitForFrame(d, "✔ all done");
    expect(submits).toBe(1);
    d.unmount();
  });

  test("reports a failure and returns to the form", async () => {
    const d = drive({
      onSubmit: () => Promise.reject(new Error("the service said no")),
    });

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");
    await waitForFrame(d, "want the extra question?");
    await d.press("return");
    await waitForFrame(d, "review");
    await d.press("return");

    await waitForFrame(d, "✗ the service said no");
    await d.press("escape");

    // Back on the review step, with the answers intact.
    await waitForFrame(d, "review");
    expect(d.lastFrame()).toContain("Ada");
    d.unmount();
  });

  test("a field validates what it would submit, not a trimmed copy of it", async () => {
    let submitted: string | undefined;
    const d = drive({
      onSubmit: async () => {
        submitted = "reached";
      },
    });

    await waitForFrame(d, "what is your name?");
    await d.write(" Ada ");
    await d.press("return");

    // The step keeps the value as typed, so it must refuse it here rather than
    // pass a trimmed copy and submit the padded one.
    await waitForFrame(d, "letters only");
    expect(d.lastFrame()).toContain("what is your name?");
    expect(submitted).toBeUndefined();
    d.unmount();
  });

  test("a required field blocks the step until it is filled", async () => {
    const d = drive();

    await waitForFrame(d, "what is your name?");
    await d.press("return");

    await waitForFrame(d, "name is required");
    expect(d.lastFrame()).toContain("what is your name?");
    d.unmount();
  });
});

// MultiChoiceField and a numeric TextField have their own harness: one answers
// with a set rather than a single value, and the other validates the number its
// text parses to.
describe("MultiChoiceField and numeric TextField", () => {
  const COLOURS = [
    { value: "red", label: "red", description: "the first" },
    { value: "green", label: "green", description: "the second" },
    { value: "blue", label: "blue", description: "the third" },
  ];

  function driveFields(onSubmit: (summary: string) => void) {
    function Harness() {
      const [colours, setColours] = useState<string[]>([]);
      const [days, setDays] = useState("30");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={() => {}}
          onSubmit={async () => onSubmit(`${colours.join(",")}|${days}`)}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="colours" prompt="pick some colours">
            <MultiChoiceField choices={COLOURS} value={colours} onChange={setColours} />
          </Step>
          <Step stepKey="days" prompt="how many days?">
            <TextField
              label="Days"
              value={days}
              onChange={setDays}
              required
              number
              schema={z.number().int().min(3).max(365)}
            />
          </Step>
        </Wizard>
      );
    }

    const instance = render(<></>);
    Object.defineProperties(instance.stdout, {
      columns: { configurable: true, value: 100 },
      rows: { configurable: true, value: 40 },
    });
    instance.rerender(<Harness />);
    return {
      lastFrame: instance.lastFrame,
      write: async (input: string) => {
        await tick();
        instance.stdin.write(input);
        await tick();
      },
      press: async (key: keyof typeof keys) => {
        await tick();
        instance.stdin.write(keys[key]);
        await tick();
      },
      unmount: instance.unmount,
    };
  }

  test("space toggles a choice and enter continues with the ones checked", async () => {
    let submitted: string | undefined;
    const d = driveFields((summary) => {
      submitted = summary;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("pick some colours"), 1000);
    // Checked bottom-up; the answer still reads in the order the choices are
    // drawn, so a review and the resource behind it agree.
    await d.press("down");
    await d.press("down");
    await d.write(" ");
    await d.press("up");
    await d.press("up");
    await d.write(" ");
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("how many days?"), 1000);
    await d.press("return");

    await waitFor(() => submitted !== undefined, 1000);
    expect(submitted).toBe("red,blue|30");
    d.unmount();
  });

  test("a number outside the schema's range keeps the step", async () => {
    let submitted: string | undefined;
    const d = driveFields((summary) => {
      submitted = summary;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("pick some colours"), 1000);
    await d.press("return");
    await waitFor(() => (d.lastFrame() ?? "").includes("how many days?"), 1000);
    // The prefilled 30 typed out to 3000.
    await d.write("00");
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("<=365"), 1000);
    expect(submitted).toBeUndefined();
    d.unmount();
  });

  test("a numeric field refuses an answer that is not a whole number", async () => {
    const d = driveFields(() => {});

    await waitFor(() => (d.lastFrame() ?? "").includes("pick some colours"), 1000);
    await d.press("return");
    await waitFor(() => (d.lastFrame() ?? "").includes("how many days?"), 1000);
    await d.write(".5");
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("Days must be a whole number"), 1000);
    d.unmount();
  });
});

describe("Wizard authoring guards", () => {
  // Ink's own render rather than ink-testing-library: a render-time throw
  // reaches Ink's error boundary and rejects waitUntilExit, which the testing
  // library does not expose.
  test("two steps sharing a step key are rejected at render", async () => {
    const { streams } = ttyTestIO();
    const { waitUntilExit } = inkRender(
      <Wizard
        breadcrumb={["agentcore", "test"]}
        onCancel={() => {}}
        onSubmit={async () => {}}
        runningLabel="working…"
        successLabel="all done"
      >
        <Step stepKey="name" prompt="first">
          <Summary items={{}} />
        </Step>
        <Step stepKey="name" prompt="second">
          <Summary items={{}} />
        </Step>
      </Wizard>,
      { stdin: streams.io.stdin, stdout: streams.io.stdout, stderr: streams.io.stderr },
    );

    const error = await waitUntilExit().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentCoreCLIError);
    expect((error as AgentCoreCLIError).source).toBe("internal");
    expect((error as Error).message).toBe('duplicate <Step stepKey="name">');
  });
});
