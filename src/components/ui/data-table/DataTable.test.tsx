import { afterEach, describe, expect, test } from "bun:test";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import stringWidth from "string-width";
import { DataTable, type DataTableColumn } from "./DataTable";

afterEach(cleanup);

interface Row extends Record<string, unknown> {
  name: string;
  status: string;
}

const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "name", flex: true },
  { key: "status", header: "status", width: 13, minWidth: 13 },
];

function renderTableAt(columnsWide: number) {
  const instance = render(<></>);
  Object.defineProperty(instance.stdout, "columns", {
    configurable: true,
    value: columnsWide,
  });
  instance.rerender(
    <Box width={columnsWide}>
      <DataTable<Row>
        borderStyle="none"
        columns={columns}
        data={[
          { name: "first-long-name", status: "CREATE_FAILED" },
          { name: "second-long-name", status: "READY" },
        ]}
        searchable={false}
        showFooter={false}
      />
    </Box>,
  );
  return instance.lastFrame() ?? "";
}

describe("DataTable layout", () => {
  test("keeps the selection marker and each logical row on one line at 12 columns", () => {
    const lines = renderTableAt(12).split("\n");
    const rowLines = lines.filter(
      (line) => line.includes("first") || line.includes("second") || line.includes("❯"),
    );

    expect(rowLines).toHaveLength(2);
    expect(rowLines.filter((line) => line.includes("❯"))).toHaveLength(1);
    expect(rowLines.every((line) => stringWidth(line) <= 18)).toBe(true);
  });

  test("renders an explicit configuration error for multiple flex columns", () => {
    const invalidColumns = [
      { key: "name", header: "name", flex: true },
      { key: "status", header: "status", flex: true },
    ] satisfies DataTableColumn<Row>[];
    const instance = render(
      <DataTable<Row>
        borderStyle="none"
        columns={invalidColumns}
        data={[]}
        searchable={false}
        showFooter={false}
      />,
    );

    expect(instance.lastFrame()).toContain("DataTable supports at most one flexible column.");
  });
});
