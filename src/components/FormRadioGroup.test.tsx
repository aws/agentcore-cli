import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { FormRadioGroup } from "./FormRadioGroup";

describe("FormRadioGroup", () => {
  test("renders keyboard focus separately from the selected radio value", () => {
    const screen = render(
      <FormRadioGroup
        helpText=""
        options={[
          { label: "selected", description: "the committed value" },
          { label: "focused", description: "the active row" },
        ]}
        focusedIndex={1}
        selectedIndex={0}
      />,
    );

    const frame = screen.lastFrame() ?? "";
    expect(frame).toContain("● selected");
    expect(frame).toContain("❯ ○ focused");
    expect(frame).not.toContain("❯ ● selected");
  });

  test("keeps selection visible when focus moves into a revealed input", () => {
    const screen = render(
      <FormRadioGroup
        helpText=""
        options={[{ label: "CUSTOM_JWT", description: "configure an OIDC provider" }]}
        selectedIndex={0}
      />,
    );

    const frame = screen.lastFrame() ?? "";
    expect(frame).toContain("● CUSTOM_JWT");
    expect(frame).not.toContain("❯");
  });
});
