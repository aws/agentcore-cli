import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import z from "zod";
import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { cleanupScreens, keys, tick, ttyTestIO, waitFor } from "../../testing";
import { AgentCoreCLIError } from "../../errors";
import { Wizard, type WizardSubmitResult } from "./Wizard";
import { Step } from "./Step";
import {
  ChoiceField,
  MultiChoiceField,
  MultiTextField,
  promptPreview,
  ResourceChoiceField,
  RevealChoiceField,
  Summary,
  TextAreaField,
  TextField,
  type Choice,
} from "./fields";

afterEach(cleanupScreens);

// The wizard shell is exercised through a synthetic flow rather than one of the
// real screens, so these tests describe the shell's own behaviour: how it
// derives steps from children, moves between them, and reports outcomes.

interface HarnessOptions {
  onSubmit?: () => WizardSubmitResult;
  onCancel?: () => void;
  onDone?: () => void;
  successNotes?: string[];
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
function TestWizard({ onSubmit, onCancel, onDone, successNotes }: HarnessOptions) {
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
      successNotes={successNotes}
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

  test("renders notes on the success screen", async () => {
    const d = drive({
      successNotes: ["Warning: the completed action needs follow-up."],
    });

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");
    await waitForFrame(d, "want the extra question?");
    await d.press("return");
    await waitForFrame(d, "review");
    await d.press("return");

    await waitForFrame(d, "Warning: the completed action needs follow-up.");
    expect(d.lastFrame()).toContain("✔ all done");
    d.unmount();
  });

  test("a streamed submit renders its steps through the shared TaskList", async () => {
    // The pause lets Ink paint between events: a generator that runs to
    // completion in one batch would only ever produce the final frame, and the
    // tail under a running step is exactly what that frame no longer shows.
    // The tail is then held on screen until the test has seen it; a timed
    // pause shows it for a few milliseconds, which a loaded runner can miss.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    let releaseTail!: () => void;
    const tailSeen = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    async function* progress() {
      yield { type: "step", message: "wrote agentcore.json" } as const;
      await pause();
      yield { type: "output", line: "a line tailing the running step" } as const;
      await tailSeen;
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
    releaseTail();

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

  function driveFields(onSubmit: (summary: string) => void, minSelections = 0) {
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
            <MultiChoiceField
              choices={COLOURS}
              value={colours}
              onChange={setColours}
              minSelections={minSelections}
              minSelectionsMessage="Pick at least one colour"
            />
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

  test("a minimum selection count blocks an empty answer", async () => {
    const d = driveFields(() => {}, 1);

    await waitFor(() => (d.lastFrame() ?? "").includes("pick some colours"), 1000);
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("Pick at least one colour"), 1000);
    expect(d.lastFrame()).toContain("pick some colours");
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

  test("a decimal field validates the parsed number", async () => {
    let submitted = false;

    function Harness() {
      const [rate, setRate] = useState("");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={() => {}}
          onSubmit={async () => {
            submitted = true;
          }}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="rate" prompt="sampling rate?">
            <TextField
              label="Sampling rate"
              value={rate}
              onChange={setRate}
              required
              decimal
              schema={z.number().min(0.01).max(100)}
            />
          </Step>
        </Wizard>
      );
    }

    const instance = render(<Harness />);
    Object.defineProperties(instance.stdout, {
      columns: { configurable: true, value: 100 },
      rows: { configurable: true, value: 40 },
    });

    await tick();
    instance.stdin.write("12.5");
    await tick();
    instance.stdin.write(keys.return);
    await waitFor(() => submitted, 1000);
    instance.unmount();
  });

  test("a decimal field refuses non-numeric text", async () => {
    function Harness() {
      const [rate, setRate] = useState("");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={() => {}}
          onSubmit={async () => {}}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="rate" prompt="sampling rate?">
            <TextField
              label="Sampling rate"
              value={rate}
              onChange={setRate}
              required
              decimal
              schema={z.number().min(0.01).max(100)}
            />
          </Step>
        </Wizard>
      );
    }

    const instance = render(<Harness />);
    Object.defineProperties(instance.stdout, {
      columns: { configurable: true, value: 100 },
      rows: { configurable: true, value: 40 },
    });

    await tick();
    instance.stdin.write("ten");
    await tick();
    instance.stdin.write(keys.return);
    await waitFor(() => (instance.lastFrame() ?? "").includes("Sampling rate must be a number"));
    instance.unmount();
  });
});

// ResourceChoiceField is a ChoiceField over the project spec; what these cover
// is the empty state a project without the resource lands on.
describe("ResourceChoiceField", () => {
  function driveResources(choices: Choice<string>[], onCancel: () => void) {
    function Harness() {
      const [gateway, setGateway] = useState(choices[0]?.value ?? "");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={onCancel}
          onSubmit={async () => {}}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="gateway" prompt="which Gateway?">
            <ResourceChoiceField
              choices={choices}
              value={gateway}
              onChange={setGateway}
              emptyMessage="no Gateways in this project"
              emptyHint="add one with  agentcore add gateway"
            />
          </Step>
          <Step stepKey="review" prompt="review">
            <Summary items={{ picked: gateway }} />
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
      press: async (key: keyof typeof keys) => {
        await tick();
        instance.stdin.write(keys[key]);
        await tick();
      },
      unmount: instance.unmount,
    };
  }

  test("with nothing to choose it names what is missing and esc leaves", async () => {
    let cancelled = false;
    const d = driveResources([], () => {
      cancelled = true;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("no Gateways in this project"), 1000);
    expect(d.lastFrame()).toContain("add one with  agentcore add gateway");
    // Only esc is on offer: enter has nothing to select. The field publishes
    // its hints after the first paint, so wait for the default enter hint to go.
    await waitFor(() => !(d.lastFrame() ?? "").includes("[enter]"), 1000);
    expect(d.lastFrame()).toContain("[esc] back");

    await d.press("return");
    expect(d.lastFrame()).toContain("no Gateways in this project");
    expect(cancelled).toBe(false);

    await d.press("escape");
    await waitFor(() => cancelled, 1000);
    d.unmount();
  });

  test("with resources it is a choice over them", async () => {
    const d = driveResources(
      [
        { value: "tools", label: "tools", description: "the first" },
        { value: "payments", label: "payments", description: "the second" },
      ],
      () => {},
    );

    await waitFor(() => (d.lastFrame() ?? "").includes("❯ ● tools"), 1000);
    expect(d.lastFrame()).not.toContain("no Gateways");
    await d.press("down");
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("picked"), 1000);
    expect(d.lastFrame()).toContain("payments");
    d.unmount();
  });
});

// RevealChoiceField opens one input under a chosen row; these cover which rows
// open it, that the input validates like a TextField, and the way back out.
describe("RevealChoiceField", () => {
  function driveReveal() {
    function Harness() {
      const [flavour, setFlavour] = useState("preset");
      const [custom, setCustom] = useState("");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={() => {}}
          onSubmit={async () => {}}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="flavour" prompt="which flavour?">
            <RevealChoiceField
              choices={[
                { value: "preset", label: "preset", description: "the built-in one" },
                { value: "custom", label: "custom", description: "type your own" },
              ]}
              value={flavour}
              onChange={setFlavour}
              input={{
                opensFor: (value) => value === "custom",
                label: "Flavour",
                name: "flavour",
                help: "lowercase letters only",
                value: custom,
                onChange: setCustom,
                required: true,
                schema: z.string().regex(/^[a-z]+$/, "letters only please"),
              }}
            />
          </Step>
          <Step stepKey="review" prompt="review">
            <Summary items={{ flavour, custom: custom === "" ? "(none)" : custom }} />
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

  test("enter on a row without a follow-up continues", async () => {
    const d = driveReveal();

    await waitFor(() => (d.lastFrame() ?? "").includes("❯ ● preset"), 1000);
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("review"), 1000);
    expect(d.lastFrame()).toContain("preset");
    expect(d.lastFrame()).not.toContain("lowercase letters only");
    d.unmount();
  });

  test("enter on the revealing row opens the input, which validates before continuing", async () => {
    const d = driveReveal();

    await waitFor(() => (d.lastFrame() ?? "").includes("❯ ● preset"), 1000);
    await d.press("down");
    await d.press("return");

    // The rows keep the value; the pointer moves into the input.
    await waitFor(() => (d.lastFrame() ?? "").includes("lowercase letters only"), 1000);
    expect(d.lastFrame()).toContain("● custom");
    expect(d.lastFrame()).not.toContain("❯ ● custom");

    await d.press("return");
    await waitFor(() => (d.lastFrame() ?? "").includes("Flavour is required"), 1000);

    await d.write("Mint");
    await d.press("return");
    await waitFor(() => (d.lastFrame() ?? "").includes("letters only please"), 1000);
    expect(d.lastFrame()).toContain("which flavour?");
    d.unmount();
  });

  test("a valid input continues, and esc from it returns to the rows keeping what was typed", async () => {
    const d = driveReveal();

    await waitFor(() => (d.lastFrame() ?? "").includes("❯ ● preset"), 1000);
    await d.press("down");
    await d.press("return");
    await waitFor(() => (d.lastFrame() ?? "").includes("lowercase letters only"), 1000);
    await d.write("mint");

    await d.press("escape");
    await waitFor(() => (d.lastFrame() ?? "").includes("❯ ● custom"), 1000);
    expect(d.lastFrame()).not.toContain("lowercase letters only");

    await d.press("return");
    await waitFor(() => (d.lastFrame() ?? "").includes("mint"), 1000);
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("review"), 1000);
    expect(d.lastFrame()).toContain("mint");
    d.unmount();
  });
});

// TextAreaField has its own harness because its key handling is the opposite of
// every other field's: enter belongs to the value, so continuing needs ctrl+d.
describe("TextAreaField", () => {
  function driveTextArea(onSubmit: (instructions: string) => void) {
    function Harness() {
      const [instructions, setInstructions] = useState("");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={() => {}}
          onSubmit={async () => onSubmit(instructions)}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="instructions" prompt="what are the instructions?">
            <TextAreaField
              label="Instructions"
              value={instructions}
              onChange={setInstructions}
              required
              schema={z.string().refine((value) => !value.includes("TODO"), "no TODOs")}
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

  test("enter builds up the value and ctrl+d submits it", async () => {
    let submitted: string | undefined;
    const d = driveTextArea((instructions) => {
      submitted = instructions;
    });

    // The field publishes its hints after the first paint, so wait for them.
    await waitFor(() => (d.lastFrame() ?? "").includes("[ctrl+d] submit"), 1000);
    expect(d.lastFrame()).toContain("[enter] newline");
    // The step is last, so on any other field this enter would submit.
    await d.write("You are a pirate.");
    await d.press("return");
    await d.write("Answer in rhyme.");
    expect(submitted).toBeUndefined();
    expect(d.lastFrame()).toContain("Answer in rhyme.");

    await d.press("ctrl+d");
    await waitFor(() => submitted !== undefined, 1000);
    expect(submitted).toBe("You are a pirate.\nAnswer in rhyme.");
    d.unmount();
  });

  test("enter on an empty required value says so instead of continuing", async () => {
    let submitted: string | undefined;
    const d = driveTextArea((instructions) => {
      submitted = instructions;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("what are the instructions?"), 1000);
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("Instructions is required"), 1000);
    expect(submitted).toBeUndefined();

    // ctrl+d on the same empty value is refused for the same reason.
    await d.press("ctrl+d");
    expect(d.lastFrame()).toContain("Instructions is required");
    expect(submitted).toBeUndefined();
    d.unmount();
  });

  test("ctrl+d on a value the schema rejects stays on the step", async () => {
    let submitted: string | undefined;
    const d = driveTextArea((instructions) => {
      submitted = instructions;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("what are the instructions?"), 1000);
    await d.write("TODO write this later");
    await d.press("ctrl+d");

    await waitFor(() => (d.lastFrame() ?? "").includes("no TODOs"), 1000);
    expect(submitted).toBeUndefined();

    // Typing again clears the message, and the corrected value goes through.
    await d.write("!");
    expect(d.lastFrame()).not.toContain("no TODOs");
    d.unmount();
  });
});

// The json and example options belong to a TextAreaField that collects a pasted
// blob: the value is parsed before the schema sees it, and the shape to copy
// stays on screen while it is typed.
describe("TextAreaField with json", () => {
  const EXAMPLE = '{"ok": true}';

  function driveJson(onSubmit: (blob: string) => void) {
    function Harness() {
      const [blob, setBlob] = useState("");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={() => {}}
          onSubmit={async () => onSubmit(blob)}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="blob" prompt="paste the configuration">
            <TextAreaField
              label="Configuration"
              example={EXAMPLE}
              value={blob}
              onChange={setBlob}
              required
              json
              schema={z.object({ ok: z.boolean() })}
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

  test("malformed JSON is reported as such, not as a schema failure", async () => {
    let submitted: string | undefined;
    const d = driveJson((blob) => {
      submitted = blob;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("paste the configuration"), 1000);
    await d.write('{"ok":');
    await d.press("ctrl+d");

    await waitFor(() => (d.lastFrame() ?? "").includes("Configuration is not valid JSON"), 1000);
    expect(submitted).toBeUndefined();
    d.unmount();
  });

  test("well-formed JSON the schema rejects names the path", async () => {
    let submitted: string | undefined;
    const d = driveJson((blob) => {
      submitted = blob;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("paste the configuration"), 1000);
    await d.write('{"ok": "yes"}');
    await d.press("ctrl+d");

    await waitFor(() => (d.lastFrame() ?? "").includes("ok: Invalid input"), 1000);
    expect(submitted).toBeUndefined();
    d.unmount();
  });

  test("the example stays on screen while typing, and a valid value submits", async () => {
    let submitted: string | undefined;
    const d = driveJson((blob) => {
      submitted = blob;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes(`for example  ${EXAMPLE}`), 1000);
    await d.write('{"ok":');
    expect(d.lastFrame()).toContain(`for example  ${EXAMPLE}`);
    await d.press("return");
    await d.write("true}");
    await d.press("ctrl+d");

    await waitFor(() => submitted !== undefined, 1000);
    expect(submitted).toBe('{"ok":\ntrue}');
    d.unmount();
  });
});

// MultiTextField stacks several inputs on one step; these cover how focus moves
// between them and that the last enter checks them all.
describe("MultiTextField", () => {
  function driveInputs(onSubmit: (summary: string) => void, onCancel: () => void = () => {}) {
    function Harness() {
      const [first, setFirst] = useState("");
      const [second, setSecond] = useState("");
      return (
        <Wizard
          breadcrumb={["agentcore", "test"]}
          onCancel={onCancel}
          onSubmit={async () => onSubmit(`${first}|${second}`)}
          runningLabel="working…"
          successLabel="all done"
        >
          <Step stepKey="pair" prompt="two answers">
            <MultiTextField
              inputs={[
                {
                  key: "first",
                  label: "First",
                  help: "required · letters only",
                  value: first,
                  onChange: setFirst,
                  required: true,
                  schema: NAME_SCHEMA,
                },
                {
                  key: "second",
                  label: "Second",
                  help: "optional",
                  value: second,
                  onChange: setSecond,
                },
              ]}
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

  test("enter moves down through the inputs and submits from the last", async () => {
    let submitted: string | undefined;
    const d = driveInputs((summary) => {
      submitted = summary;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("two answers"), 1000);
    await d.write("alpha");
    await d.press("return");
    expect(submitted).toBeUndefined();
    await d.write("beta");
    await d.press("return");

    await waitFor(() => submitted !== undefined, 1000);
    expect(submitted).toBe("alpha|beta");
    d.unmount();
  });

  test("an input skipped with the arrows is checked on the last enter", async () => {
    let submitted: string | undefined;
    const d = driveInputs((summary) => {
      submitted = summary;
    });

    await waitFor(() => (d.lastFrame() ?? "").includes("two answers"), 1000);
    await d.press("down");
    await d.write("beta");
    await d.press("return");

    await waitFor(() => (d.lastFrame() ?? "").includes("First is required"), 1000);
    expect(submitted).toBeUndefined();

    // Focus went back to the offending input, so typing fixes it in place.
    await d.write("alpha");
    await d.press("return");
    await d.press("return");
    await waitFor(() => submitted !== undefined, 1000);
    expect(submitted).toBe("alpha|beta");
    d.unmount();
  });

  test("esc leaves the step", async () => {
    let cancelled = false;
    const d = driveInputs(
      () => {},
      () => {
        cancelled = true;
      },
    );

    await waitFor(() => (d.lastFrame() ?? "").includes("two answers"), 1000);
    await d.press("escape");
    await waitFor(() => cancelled, 1000);
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

describe("promptPreview", () => {
  test.each([
    ["a one-line prompt", "You are a pirate.", "You are a pirate."],
    ["counts every line", "You are a pirate.\nAnswer in rhyme.", "You are a pirate. · 2 lines"],
    ["keeps a leading blank line", "\nYou are a pirate.", " · 2 lines"],
    [
      "counts a trailing newline left by enter",
      "You are a pirate.\n",
      "You are a pirate. · 2 lines",
    ],
    ["cuts a long first line short", `${"x".repeat(70)}\ny`, `${"x".repeat(59)}… · 2 lines`],
    ["cuts a long single line short", "x".repeat(70), `${"x".repeat(59)}…`],
  ])("%s", (_label, prompt, preview) => {
    expect(promptPreview(prompt)).toBe(preview);
  });
});
