import { useState } from "react";

// WindowRow is one terminal row of a scrolled list: an item, the divider of the
// section an item is listed under, or a marker counting the items scrolled out
// of view above or below.
export type WindowRow =
  | { kind: "more-above"; count: number }
  | { kind: "section"; title: string }
  | { kind: "item"; index: number }
  | { kind: "more-below"; count: number };

export interface ScrollWindow {
  // start and end bound the visible items, [start, end).
  start: number;
  end: number;
  // rows are what to render, top to bottom; never more than the budget unless
  // the budget is below one row.
  rows: WindowRow[];
}

export interface ScrollWindowInput {
  // sections holds each item's section title (undefined for none). A section's
  // divider is drawn above its first item, and above the window's first item
  // when the window starts mid-section.
  sections: readonly (string | undefined)[];
  // highlight is the item that must stay visible.
  highlight: number;
  // start is the previous window's first item; the window scrolls from there
  // only as far as it must to keep the highlight visible.
  start: number;
  // budget is how many terminal rows the list may use.
  budget: number;
}

function startsSection(sections: ScrollWindowInput["sections"], i: number, start: number) {
  return sections[i] !== undefined && (i === start || sections[i - 1] !== sections[i]);
}

function windowCost(sections: ScrollWindowInput["sections"], start: number, end: number) {
  let cost = (start > 0 ? 1 : 0) + (end < sections.length ? 1 : 0);
  for (let i = start; i < end; i++) cost += startsSection(sections, i, start) ? 2 : 1;
  return cost;
}

// scrollWindow picks which items of a list fit `budget` terminal rows, keeping
// the highlighted item visible and scrolling minimally from the previous start.
export function scrollWindow({
  sections,
  highlight,
  start,
  budget,
}: ScrollWindowInput): ScrollWindow {
  const count = sections.length;
  if (count === 0) return { start: 0, end: 0, rows: [] };
  const limit = Math.max(1, budget);
  const hl = Math.min(Math.max(0, highlight), count - 1);

  let first = Math.min(Math.max(0, start), hl);
  while (first < hl && windowCost(sections, first, hl + 1) > limit) first++;
  let end = hl + 1;
  while (end < count && windowCost(sections, first, end + 1) <= limit) end++;
  if (end === count) {
    while (first > 0 && windowCost(sections, first - 1, count) <= limit) first--;
  }

  let rows: WindowRow[] = [];
  if (first > 0) rows.push({ kind: "more-above", count: first });
  for (let i = first; i < end; i++) {
    if (startsSection(sections, i, first)) rows.push({ kind: "section", title: sections[i]! });
    rows.push({ kind: "item", index: i });
  }
  if (end < count) rows.push({ kind: "more-below", count: count - end });

  // Too short for even the highlight's context: drop the context, keeping the
  // highlighted item itself.
  for (const kind of ["more-below", "more-above", "section"] as const) {
    if (rows.length <= limit) break;
    rows = rows.filter((row) => row.kind !== kind);
  }

  return { start: first, end, rows };
}

// useScrollWindow is scrollWindow with the window's start remembered across
// renders, so moving the highlight or resizing scrolls from where the list was.
export function useScrollWindow(
  sections: ScrollWindowInput["sections"],
  highlight: number,
  budget: number,
): ScrollWindow {
  const [start, setStart] = useState(0);
  const window = scrollWindow({ sections, highlight, start, budget });
  if (window.start !== start) setStart(window.start);
  return window;
}
