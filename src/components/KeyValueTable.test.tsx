import { afterEach, expect, test } from "bun:test";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import stringWidth from "string-width";
import { KeyValueTable } from "./KeyValueTable";

afterEach(cleanup);

function valueColumn(frame: string, value: string): number {
  const line = frame.split("\n").find((line) => line.includes(value));
  expect(line).toBeDefined();
  return stringWidth(line!.slice(0, line!.indexOf(value)));
}

test("standalone records retain their spacing without section indentation", () => {
  const r = render(
    <Box width={60}>
      <KeyValueTable items={{ id: "abc", status: "READY" }} />
    </Box>,
  );

  expect(r.lastFrame()).toBe("id      abc\nstatus  READY");
});

test("sections share one column regardless of heading length or repeated labels", () => {
  const r = render(
    <Box width={100}>
      <KeyValueTable
        sections={[
          {
            title: "a heading much longer than any key",
            rows: [
              ["10", "FIRST"],
              ["2", "SECOND"],
              ["10", "THIRD"],
            ],
          },
          { title: "last", rows: [["longest-key", "FOURTH"]] },
        ]}
      />
    </Box>,
  );
  const frame = r.lastFrame()!;
  const values = ["FIRST", "SECOND", "THIRD", "FOURTH"];

  expect(values.map((value) => valueColumn(frame, value))).toEqual([15, 15, 15, 15]);
  const positions = values.map((value) => frame.indexOf(value));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("empty sections disappear and untitled sections share titled-row indentation", () => {
  const r = render(
    <Box width={80}>
      <KeyValueTable
        sections={[
          { title: "empty section", rows: [] },
          { rows: [["a", "FIRST"]] },
          {
            title: "section",
            rows: [
              ["b", "SECOND"],
              ["empty-value", ""],
            ],
          },
          { title: "section", rows: [["", "THIRD"]] },
        ]}
      />
    </Box>,
  );
  const frame = r.lastFrame()!;

  expect(frame).not.toContain("empty section");
  expect(frame).toContain("empty-value");
  expect(frame.match(/^section$/gm)).toHaveLength(2);
  expect(["FIRST", "SECOND", "THIRD"].map((value) => valueColumn(frame, value))).toEqual([
    15, 15, 15,
  ]);
});

test("empty inputs render no headings or rows", () => {
  const r = render(<KeyValueTable items={{}} />);
  expect(r.lastFrame()).toBe("");
  r.rerender(<KeyValueTable sections={[{ title: "empty", rows: [] }]} />);
  expect(r.lastFrame()).toBe("");
});

test("measurement uses display cells and the widest explicit line", () => {
  const r = render(
    <Box width={60}>
      <KeyValueTable
        sections={[
          {
            rows: [
              ["\u754c\u754c", "WIDE"],
              ["e\u0301", "COMBINING"],
              ["\u{1f600}", "EMOJI"],
              ["\u001b[31mred\u001b[39m", "STYLED"],
              ["ab\nc", "MULTILINE"],
            ],
          },
        ]}
      />
    </Box>,
  );
  const frame = r.lastFrame()!;

  expect(
    ["WIDE", "COMBINING", "EMOJI", "STYLED", "MULTILINE"].map((value) => valueColumn(frame, value)),
  ).toEqual([6, 6, 6, 6, 6]);
});

test.each([40, 61, 100, 180])(
  "wraps both cells within a padded %i-column parent without losing text",
  (width) => {
    const key = `--${"k".repeat(58)}`;
    const value = "V".repeat(80);
    const r = render(
      <Box width={width} paddingX={2}>
        <KeyValueTable
          sections={[
            { title: "first", rows: [["short", "FIRST"]] },
            { title: "last", rows: [[key, value]] },
          ]}
        />
      </Box>,
    );
    const frame = r.lastFrame()!;
    const lines = frame.split("\n");
    const column = valueColumn(frame, "FIRST");
    const valueLines = lines.filter((line) => line.includes("V"));

    expect(valueLines.length).toBeGreaterThan(0);
    expect(valueLines.every((line) => valueColumn(line, "V") === column)).toBe(true);
    expect(valueLines.every((line) => line.slice(column - 2, column) === "  ")).toBe(true);
    expect(valueLines.map((line) => line.slice(column).trimEnd()).join("")).toBe(value);
    expect(
      lines
        .filter((line) => line.includes("k"))
        .map((line) => line.slice(4, column).trimEnd())
        .join(""),
    ).toBe(key);
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
  },
);
