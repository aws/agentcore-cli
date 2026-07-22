import { afterEach, expect, test } from "bun:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { tick, waitFor } from "../../../testing";
import { DataTable } from "./DataTable";

afterEach(cleanup);

test("uses pagination-agnostic filter copy by default", async () => {
  const table = render(
    <DataTable columns={[{ key: "name", header: "name" }]} data={[{ name: "alpha" }]} />,
  );

  await tick();
  table.stdin.write("/");
  await tick();
  table.stdin.write("missing");
  await waitFor(() => (table.lastFrame() ?? "").includes("missing"));

  const frame = table.lastFrame()!;
  expect(frame).toContain("/ Filter: missing");
  expect(frame).toContain("No matches");
  expect(frame).not.toContain("No matches on this page");
});
