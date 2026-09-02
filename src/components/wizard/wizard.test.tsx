import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { render } from "ink-testing-library";
import { cleanupScreens, keys, tick, waitFor } from "../../testing";
import { Wizard, type WizardSubmitResult } from "./Wizard";
import { Step } from "./Step";
import { ChoiceField, Summary, TextField } from "./fields";

afterEach(cleanupScreens);

// The wizard shell is exercised through a synthetic flow rather than one of the
// real screens, so these tests describe the shell's own behaviour: how it
// derives steps from children, moves between them, and reports outcomes.

interface HarnessOptions {
  onSubmit?: () => WizardSubmitResult;
  onCancel?: () => void;
  onError?: "exit" | "retry";
  onDone?: () => void;
}

const YES_NO = [
  { value: false, label: "no", description: "skip the extra question" },
  { value: true, label: "yes", description: "ask the extra question" },
];

// TestWizard has one conditional step, so the branch behaviour under test is
// expressed the way a screen expresses it: `{condition && <Step/>}`.
function TestWizard({ onSubmit, onCancel, onError, onDone }: HarnessOptions) {
  const [name, setName] = useState("");
  const [wantsExtra, setWantsExtra] = useState(false);
  const [extra, setExtra] = useState("");

  return (
    <Wizard
      breadcrumb={["agentcore", "test"]}
      description="a synthetic flow"
      onCancel={onCancel ?? (() => {})}
      onSubmit={onSubmit ?? (async () => {})}
      onError={onError}
      onDone={onDone}
      runningLabel="working…"
      successLabel="all done"
      successHint="enter exits"
    >
      <Step name="name" question="what is your name?">
        <TextField label="name" value={name} onChange={setName} required />
      </Step>

      <Step name="branch" question="want the extra question?">
        <ChoiceField choices={YES_NO} value={wantsExtra} onChange={setWantsExtra} />
      </Step>

      {wantsExtra && (
        <Step name="extra" question="the extra question">
          <TextField label="extra" value={extra} onChange={setExtra} />
        </Step>
      )}

      <Step name="review" question="review">
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
    expect(d.lastFrame()).toContain("[↑↓] choose");
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

  test("a streamed submit renders each progress message", async () => {
    async function* progress() {
      yield { message: "wrote agentcore.json" };
      yield { message: "updated the deploy target" };
    }
    const d = drive({ onSubmit: () => progress() });

    await waitForFrame(d, "what is your name?");
    await d.write("Ada");
    await d.press("return");
    await waitForFrame(d, "want the extra question?");
    await d.press("return");
    await waitForFrame(d, "review");
    await d.press("return");

    await waitForFrame(d, "✔ all done");
    const frame = d.lastFrame()!;
    expect(frame).toContain("wrote agentcore.json");
    expect(frame).toContain("updated the deploy target");
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

  test("onError retry reports the failure and returns to the form", async () => {
    const d = drive({
      onError: "retry",
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

  test("a required field blocks the step until it is filled", async () => {
    const d = drive();

    await waitForFrame(d, "what is your name?");
    await d.press("return");

    await waitForFrame(d, "name is required");
    expect(d.lastFrame()).toContain("what is your name?");
    d.unmount();
  });
});
