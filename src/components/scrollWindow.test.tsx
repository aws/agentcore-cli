import { test, expect, describe } from "bun:test";
import { scrollWindow, type WindowRow } from "./scrollWindow";

const plain = (count: number) => Array.from({ length: count }, () => undefined);

// show renders rows as short strings so layouts read at a glance.
function show(rows: WindowRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "item") return String(row.index);
    if (row.kind === "section") return `[${row.title}]`;
    return `${row.kind === "more-above" ? "↑" : "↓"}${row.count}`;
  });
}

describe("scrollWindow", () => {
  test("shows everything, without markers, when the list fits", () => {
    const sections = [undefined, undefined, "a", "a", "b"];
    const view = scrollWindow({ sections, highlight: 4, start: 0, budget: 7 });
    expect(view).toMatchObject({ start: 0, end: 5 });
    expect(show(view.rows)).toEqual(["0", "1", "[a]", "2", "3", "[b]", "4"]);
  });

  test("an empty list has no rows", () => {
    expect(scrollWindow({ sections: [], highlight: 0, start: 3, budget: 5 })).toEqual({
      start: 0,
      end: 0,
      rows: [],
    });
  });

  test("marks the items hidden below the window", () => {
    const view = scrollWindow({ sections: plain(10), highlight: 0, start: 0, budget: 4 });
    expect(show(view.rows)).toEqual(["0", "1", "2", "↓7"]);
  });

  test("scrolls down only as far as the highlight needs", () => {
    const view = scrollWindow({ sections: plain(10), highlight: 4, start: 0, budget: 5 });
    expect(show(view.rows)).toEqual(["↑2", "2", "3", "4", "↓5"]);
  });

  test("keeps the window still while the highlight moves inside it", () => {
    const view = scrollWindow({ sections: plain(10), highlight: 3, start: 2, budget: 5 });
    expect(show(view.rows)).toEqual(["↑2", "2", "3", "4", "↓5"]);
  });

  test("scrolls up to a highlight above the window", () => {
    const view = scrollWindow({ sections: plain(10), highlight: 4, start: 6, budget: 5 });
    expect(show(view.rows)).toEqual(["↑4", "4", "5", "6", "↓3"]);
  });

  test("returns to the top, without an up marker, when the highlight does", () => {
    const view = scrollWindow({ sections: plain(10), highlight: 0, start: 6, budget: 5 });
    expect(show(view.rows)).toEqual(["0", "1", "2", "3", "↓6"]);
  });

  test("reaching the last item drops the down marker", () => {
    const view = scrollWindow({ sections: plain(10), highlight: 9, start: 0, budget: 5 });
    expect(show(view.rows)).toEqual(["↑6", "6", "7", "8", "9"]);
  });

  test("counts section dividers against the budget", () => {
    const sections = [undefined, undefined, "a", "a", "a"];
    const view = scrollWindow({ sections, highlight: 2, start: 0, budget: 4 });
    expect(show(view.rows)).toEqual(["↑2", "[a]", "2", "↓2"]);
  });

  test("repeats the section divider when the window starts mid-section", () => {
    const sections = [undefined, "a", "a", "a", "a", "b", "b"];
    const view = scrollWindow({ sections, highlight: 4, start: 0, budget: 5 });
    expect(show(view.rows)).toEqual(["↑3", "[a]", "3", "4", "↓2"]);
  });

  test("pulls the window back up when a taller budget reaches the end", () => {
    const view = scrollWindow({ sections: plain(10), highlight: 9, start: 6, budget: 20 });
    expect(view.start).toBe(0);
    expect(show(view.rows)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  test("a start past a shrunken list is pulled back to fill the window", () => {
    const view = scrollWindow({ sections: plain(3), highlight: 2, start: 8, budget: 5 });
    expect(show(view.rows)).toEqual(["0", "1", "2"]);
  });

  test("a shrinking budget keeps the highlight visible", () => {
    const view = scrollWindow({ sections: plain(20), highlight: 12, start: 5, budget: 4 });
    expect(show(view.rows)).toEqual(["↑11", "11", "12", "↓7"]);
  });

  test("never exceeds the budget", () => {
    const sections = [undefined, "a", "a", "b", "b", "b", "c", undefined, "d"];
    for (let budget = 1; budget <= 14; budget++) {
      let start = 0;
      for (let highlight = 0; highlight < sections.length; highlight++) {
        const view = scrollWindow({ sections, highlight, start, budget });
        expect(view.rows.length).toBeLessThanOrEqual(budget);
        expect(view.rows).toContainEqual({ kind: "item", index: highlight });
        start = view.start;
      }
    }
  });

  test("keeps at least the highlighted item on a tiny budget", () => {
    const sections = [undefined, "a", "a", "a"];
    expect(show(scrollWindow({ sections, highlight: 2, start: 0, budget: 0 }).rows)).toEqual(["2"]);
    expect(show(scrollWindow({ sections, highlight: 2, start: 0, budget: 2 }).rows)).toEqual([
      "[a]",
      "2",
    ]);
  });
});
