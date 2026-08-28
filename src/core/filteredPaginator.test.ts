import { describe, expect, test } from "bun:test";
import { InputValidationError, ResultTruncationError } from "../errors";
import { FilteredPaginator } from "./filteredPaginator";

type Row = { id: string; keep: boolean };

const keep = (r: Row) => r.keep;

function makeSource(rows: Row[], servicePage: number) {
  const calls: Array<{ token: string | undefined; size: number | undefined }> = [];
  const fetchPage = async (token: string | undefined, size: number | undefined) => {
    calls.push({ token, size });
    const start = token === undefined ? 0 : Number(token);
    const take = size ?? servicePage;
    const items = rows.slice(start, start + take);
    const end = start + items.length;
    return { items, nextToken: end < rows.length ? String(end) : undefined };
  };
  return { fetchPage, calls };
}

const rows = (spec: string): Row[] =>
  [...spec].map((c, i) => ({ id: c === "." ? `x${i}` : c, keep: c !== "." }));

describe("FilteredPaginator", () => {
  test("rejects a non-positive or non-integer maxResults", async () => {
    const { fetchPage } = makeSource(rows("AB"), 10);
    for (const maxResults of [0, -1, 1.5]) {
      await expect(
        FilteredPaginator.paginate({
          fetchPage,
          predicate: keep,
          nextToken: undefined,
          maxResults,
          defaultPageSize: 10,
          resourceLabel: "Test",
        }),
      ).rejects.toBeInstanceOf(InputValidationError);
    }
  });

  test("empty source returns an empty page and no token", async () => {
    const { fetchPage } = makeSource([], 10);
    await expect(
      FilteredPaginator.paginate({
        fetchPage,
        predicate: keep,
        nextToken: undefined,
        maxResults: 5,
        defaultPageSize: 10,
        resourceLabel: "Test",
      }),
    ).resolves.toEqual({ items: [], nextToken: undefined });
  });

  test("no matches: scans to exhaustion, returns empty with no token", async () => {
    const { fetchPage, calls } = makeSource(rows("......"), 3);
    const page = await FilteredPaginator.paginate({
      fetchPage,
      predicate: keep,
      nextToken: undefined,
      maxResults: 5,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(page).toEqual({ items: [], nextToken: undefined });
    expect(calls.length).toBe(2);
  });

  test("under-fill: fewer matches than pageSize, ends with no token", async () => {
    const { fetchPage } = makeSource(rows("A.B"), 10);
    const page = await FilteredPaginator.paginate({
      fetchPage,
      predicate: keep,
      nextToken: undefined,
      maxResults: 5,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(page.items.map((r) => r.id)).toEqual(["A", "B"]);
    expect(page.nextToken).toBeUndefined();
  });

  test("normal overshoot: trims to pageSize, hands back this page's token, dup on next page", async () => {
    const src = rows("AB.CD.");
    const first = await FilteredPaginator.paginate({
      fetchPage: makeSource(src, 3).fetchPage,
      predicate: keep,
      nextToken: undefined,
      maxResults: 3,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(first.items.map((r) => r.id)).toEqual(["A", "B", "C"]);
    expect(first.nextToken).toBe("3");

    const second = await FilteredPaginator.paginate({
      fetchPage: makeSource(src, 3).fetchPage,
      predicate: keep,
      nextToken: first.nextToken,
      maxResults: 3,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(second.items.map((r) => r.id)).toEqual(["C", "D"]);
    expect(second.nextToken).toBeUndefined();
  });

  test("guard: a single page holding a full page of matches over-returns and advances (no loop)", async () => {
    const src = rows("ABCDE");
    const first = await FilteredPaginator.paginate({
      fetchPage: makeSource(src, 3).fetchPage,
      predicate: keep,
      nextToken: undefined,
      maxResults: 2,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(first.items.map((r) => r.id)).toEqual(["A", "B", "C"]);
    expect(first.nextToken).toBe("3");

    const second = await FilteredPaginator.paginate({
      fetchPage: makeSource(src, 3).fetchPage,
      predicate: keep,
      nextToken: first.nextToken,
      maxResults: 2,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(second.items.map((r) => r.id)).toEqual(["D", "E"]);
    expect(second.nextToken).toBeUndefined();
  });

  test("throws ResultTruncationError past the scan cap", async () => {
    const { fetchPage } = makeSource(rows(".".repeat(200)), 1);
    await expect(
      FilteredPaginator.paginate({
        fetchPage,
        predicate: keep,
        nextToken: undefined,
        maxResults: 1,
        defaultPageSize: 10,
        resourceLabel: "Online insight",
      }),
    ).rejects.toBeInstanceOf(ResultTruncationError);
  });

  test("passes scanPageSize to every fetch; omitting it uses the service default", async () => {
    const withScan = makeSource(rows("AB.CD."), 3);
    await FilteredPaginator.paginate({
      fetchPage: withScan.fetchPage,
      predicate: keep,
      nextToken: undefined,
      maxResults: 3,
      defaultPageSize: 10,
      scanPageSize: 7,
      resourceLabel: "Test",
    });
    expect(withScan.calls.every((c) => c.size === 7)).toBe(true);

    const noScan = makeSource(rows("AB.CD."), 3);
    await FilteredPaginator.paginate({
      fetchPage: noScan.fetchPage,
      predicate: keep,
      nextToken: undefined,
      maxResults: 3,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(noScan.calls.every((c) => c.size === undefined)).toBe(true);
  });

  test("seeds the first fetch with the caller's nextToken", async () => {
    const { fetchPage, calls } = makeSource(rows("ABCDEF"), 2);
    await FilteredPaginator.paginate({
      fetchPage,
      predicate: keep,
      nextToken: "2",
      maxResults: 1,
      defaultPageSize: 10,
      resourceLabel: "Test",
    });
    expect(calls[0]!.token).toBe("2");
  });

  test("falls back to defaultPageSize when maxResults is undefined", async () => {
    const { fetchPage } = makeSource(rows("ABC"), 1);
    const page = await FilteredPaginator.paginate({
      fetchPage,
      predicate: keep,
      nextToken: undefined,
      maxResults: undefined,
      defaultPageSize: 2,
      resourceLabel: "Test",
    });
    expect(page.items.map((r) => r.id)).toEqual(["A", "B"]);
    expect(page.nextToken).toBe("1");
  });
});
