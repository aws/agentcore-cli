import type { SpecEntries } from "./types";

/** Combines several {@link SpecEntries} into one, concatenating each resource collection. */
export function mergeSpecEntries(entries: SpecEntries[]): SpecEntries {
  const runtimes = entries.flatMap(({ runtimes }) => runtimes ?? []);
  const credentials = entries.flatMap(({ credentials }) => credentials ?? []);
  const memories = entries.flatMap(({ memories }) => memories ?? []);
  const harnesses = entries.flatMap(({ harnesses }) => harnesses ?? []);
  const box = entries.some(({ projectType }) => projectType === "box");

  return {
    ...(runtimes.length > 0 && { runtimes }),
    ...(credentials.length > 0 && { credentials }),
    ...(memories.length > 0 && { memories }),
    ...(harnesses.length > 0 && { harnesses }),
    ...(box && { projectType: "box" as const }),
  };
}
