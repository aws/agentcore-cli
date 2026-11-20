import { InputValidationError } from "../../../errors";

// The SDK drops keys its model does not know, so a misspelled key would otherwise be sent as
// nothing at all: a typo in redactionConfiguration silently disables redaction. Checking the
// known shape here turns that into an error the user can act on. A key the service adds later
// reaches the CLI only through an SDK bump anyway, so this list moves with that bump.
type Shape = { [key: string]: Shape | "leaf" | "list" };

const TIME_WINDOW = { startTime: "leaf", endTime: "leaf" } as const;

const GENERATION_CONFIG: Shape = {
  sourceConfig: {
    cloudWatchLogs: {
      logGroupNames: "leaf",
      logGroupNamePrefixes: "leaf",
      serviceNames: "leaf",
      ...TIME_WINDOW,
    },
    onlineEvaluation: { onlineEvaluationConfigArn: "leaf", ...TIME_WINDOW },
    batchEvaluation: { batchEvaluationArn: "leaf" },
  },
  selection: {
    filters: {
      attributeFilters: "list",
      turnCount: { min: "leaf", max: "leaf" },
      evaluatorFilters: "list",
    },
    identifiers: { sessionIds: "leaf", traceIds: "leaf" },
  },
  sampling: { maxScenarios: "leaf" },
  groundTruth: { fields: "leaf", qualityFilters: "list" },
  redactionConfiguration: { identifiers: "leaf", customDataIdentifiers: "list" },
};

// assertKnownGenerationConfigKeys throws on the first key the generation config shape does not
// have, naming its path and the closest known key at that level.
export function assertKnownGenerationConfigKeys(config: object): void {
  walk(config as Record<string, unknown>, GENERATION_CONFIG, "");
}

function walk(value: Record<string, unknown>, shape: Shape, path: string): void {
  for (const [key, child] of Object.entries(value)) {
    const known = shape[key];
    const at = path ? `${path}.${key}` : key;
    if (known === undefined) {
      const suggestion = closest(key, Object.keys(shape));
      throw new InputValidationError(
        `Unknown key '${at}' in '--generation-config'` +
          (suggestion ? `; did you mean '${path ? `${path}.` : ""}${suggestion}'?` : "") +
          ` Known keys here: ${Object.keys(shape).join(", ")}`,
      );
    }
    if (
      typeof known === "object" &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      walk(child as Record<string, unknown>, known, at);
    }
  }
}

// closest returns the known key nearest to `key` (case-insensitive edit distance), or undefined
// when none is near enough to be a plausible typo.
function closest(key: string, candidates: string[]): string | undefined {
  const target = key.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(target, name.toLowerCase());
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (!best) return undefined;
  const isPrefix =
    best.name.toLowerCase().startsWith(target) || target.startsWith(best.name.toLowerCase());
  return best.distance <= Math.max(2, Math.floor(best.name.length / 3)) || isPrefix
    ? best.name
    : undefined;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}
