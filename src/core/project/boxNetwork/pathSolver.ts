/**
 * Finds a request path that a set of path tests allow together, as Box compares a path: a `like`
 * pattern matches the whole path, and its `*` matches any run of characters.
 */
import type { FieldAtom } from "./conditions";
import type { LikePattern } from "./dogwood";

/** A path test: the path matches `pattern`, or, when `matches` is false, does not match it. */
export interface PathTest {
  readonly pattern: LikePattern;
  readonly matches: boolean;
}

/** A path, or no path; `undecided` when the search stops at {@link MAX_PATH_STATES}. */
export type PathSearch =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "none" }
  | { readonly kind: "undecided" };

/** The most search states before the search stops undecided. */
export const MAX_PATH_STATES = 4096;

/** Each request path starts with `/`. */
const ROOTED: PathTest = {
  pattern: { parts: [{ kind: "literal", text: "/" }, { kind: "wildcard" }] },
  matches: true,
};

/** The test of a path atom, or the atom's value on every path when it does not read the path. */
export function pathTest(atom: FieldAtom): PathTest | boolean {
  const comparison = atom.comparison;
  if (comparison.op === "present") return !atom.negated;
  if (comparison.op === "like") return { pattern: comparison.pattern, matches: !atom.negated };
  if (typeof comparison.value !== "string") return atom.negated;
  const pattern: LikePattern = { parts: [{ kind: "literal", text: comparison.value }] };
  if (comparison.op === "==") return { pattern, matches: !atom.negated };
  if (comparison.op === "!=") return { pattern, matches: atom.negated };
  return atom.negated;
}

/**
 * The shortest path that passes each test of `required` and fails at least one test of each group
 * of `excluded`. A character that no pattern names is written as `filler`.
 */
export function findPath(
  required: readonly PathTest[],
  excluded: readonly (readonly PathTest[])[],
  filler: string,
): PathSearch {
  if (excluded.some((group) => group.length === 0)) return { kind: "none" };
  const patterns: LikePattern[] = [];
  const indexOf = (pattern: LikePattern) => {
    const at = patterns.indexOf(pattern);
    return at === -1 ? patterns.push(pattern) - 1 : at;
  };
  const wanted = [ROOTED, ...required].map((test) => ({ ...test, at: indexOf(test.pattern) }));
  const groups = excluded.map((group) =>
    group.map((test) => ({ ...test, at: indexOf(test.pattern) })),
  );
  const machines = patterns.map(machineOf);
  const literals = new Set(patterns.flatMap((p) => p.parts.flatMap(literalChars)));
  const alphabet = [...literals, freeChar(literals, filler)];

  const start = machines.map((machine) => machine.closure([0]));
  const holds = (state: readonly number[][], test: { at: number; matches: boolean }) =>
    machines[test.at]!.accepts(state[test.at]!) === test.matches;
  const accepted = (state: readonly number[][]) =>
    wanted.every((test) => holds(state, test)) &&
    groups.every((group) => !group.every((test) => holds(state, test)));
  const dead = (state: readonly number[][]) =>
    wanted.some((test) => test.matches && state[test.at]!.length === 0);

  const key = (state: readonly number[][]) => state.map((set) => set.join(",")).join("|");
  const from = new Map<string, { readonly parent?: string; readonly char?: string }>();
  from.set(key(start), {});
  const queue: number[][][] = [start];
  for (let head = 0; head < queue.length; head++) {
    const state = queue[head]!;
    if (accepted(state)) return { kind: "path", path: pathTo(from, key(state)) };
    for (const char of alphabet) {
      const next = state.map((set, i) => machines[i]!.step(set, char));
      const nextKey = key(next);
      if (from.has(nextKey) || dead(next)) continue;
      if (from.size >= MAX_PATH_STATES) return { kind: "undecided" };
      from.set(nextKey, { parent: key(state), char });
      queue.push(next);
    }
  }
  return { kind: "none" };
}

/** A pattern as a machine whose state is the set of places in the pattern a prefix reaches. */
function machineOf(pattern: LikePattern) {
  const items = pattern.parts.flatMap((part) =>
    part.kind === "wildcard" ? [undefined] : [...part.text],
  );
  const closure = (places: readonly number[]) => {
    const reached = new Set<number>();
    for (let place of places) {
      reached.add(place);
      while (place < items.length && items[place] === undefined) reached.add(++place);
    }
    return [...reached].sort((a, b) => a - b);
  };
  return {
    closure,
    step: (places: readonly number[], char: string) =>
      closure(
        places.flatMap((place) => {
          if (place >= items.length) return [];
          const item = items[place];
          if (item === undefined) return [place];
          return item === char ? [place + 1] : [];
        }),
      ),
    accepts: (places: readonly number[]) => places.includes(items.length),
  };
}

function literalChars(part: LikePattern["parts"][number]): string[] {
  return part.kind === "literal" ? [...part.text] : [];
}

/** `filler`, or another character that no pattern names. */
function freeChar(literals: ReadonlySet<string>, filler: string): string {
  if (!literals.has(filler)) return filler;
  for (let code = 0xe000; ; code++) {
    const char = String.fromCharCode(code);
    if (!literals.has(char)) return char;
  }
}

function pathTo(
  from: ReadonlyMap<string, { readonly parent?: string; readonly char?: string }>,
  end: string,
): string {
  const chars: string[] = [];
  for (let at = from.get(end); at?.parent !== undefined; at = from.get(at.parent)) {
    chars.push(at.char!);
  }
  return chars.reverse().join("");
}
