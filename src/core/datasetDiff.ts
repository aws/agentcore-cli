import { isDeepStrictEqual } from "node:util";
import { InputValidationError, MalformedServiceResponseError } from "../errors";
import { parseJsonObjectLines, type JsonObject } from "../io";

// One dataset example as it appears in a JSONL file: an opaque JSON document,
// carrying an `exampleId` once the service has assigned one.
export type DatasetExample = JsonObject;

export type ParsedExample = {
  exampleId?: string;
  content: DatasetExample;
};

// An example to add, paired with the line it came from so the assigned id can be
// written back to that exact row.
export type Addition = {
  localIndex: number;
  content: DatasetExample;
};

export type DatasetDiff = {
  additions: Addition[];
  updates: DatasetExample[];
  deleteIds: string[];
  unchanged: number;
};

const EXAMPLE_ID = "exampleId";

// parseJsonl applies the local-draft rules to decoded JSONL objects.
export function parseJsonl(text: string, flagName: string): ParsedExample[] {
  return parseJsonObjectLines(text, `'--${flagName}'`).map(({ value: content, lineNumber }) => {
    const id = content[EXAMPLE_ID];
    if (Object.hasOwn(content, EXAMPLE_ID) && (typeof id !== "string" || id.trim() === "")) {
      throw new InputValidationError(
        `Invalid exampleId in '--${flagName}' at line ${lineNumber}: ` +
          `expected a non-empty string`,
      );
    }

    return { exampleId: id as string | undefined, content };
  });
}

// indexRemoteById maps remote examples by exampleId. Every remote row must carry one
// unique id; otherwise the CLI cannot address it safely for update or deletion.
export function indexRemoteById(examples: ParsedExample[]): Map<string, DatasetExample> {
  const byId = new Map<string, DatasetExample>();
  examples.forEach((example, index) => {
    const id = example.exampleId;
    if (!id) {
      throw new MalformedServiceResponseError(
        `Remote dataset example ${index + 1} is missing a valid exampleId`,
        { meta: { index } },
      );
    }
    if (byId.has(id)) {
      throw new MalformedServiceResponseError(
        `Remote dataset contains duplicate exampleId "${id}"`,
        { meta: { exampleId: id, index } },
      );
    }
    byId.set(id, example.content);
  });
  return byId;
}

function validateUniqueLocalIds(local: ParsedExample[]): void {
  const ids = new Set<string>();
  for (const example of local) {
    const id = example.exampleId;
    if (id === undefined) continue;
    if (ids.has(id)) {
      throw new InputValidationError(`Local dataset contains duplicate exampleId "${id}"`, {
        meta: { exampleId: id },
      });
    }
    ids.add(id);
  }
}

// diffExamples compares local examples against the remote DRAFT, keyed on
// exampleId. A local row whose id is absent remotely becomes an addition rather
// than an error: the id may be stale from a dataset that was recreated.
export function diffExamples(
  local: ParsedExample[],
  remote: Map<string, DatasetExample>,
): DatasetDiff {
  validateUniqueLocalIds(local);

  const additions: Addition[] = [];
  const updates: DatasetExample[] = [];
  const matched = new Set<string>();
  let unchanged = 0;

  local.forEach((example, localIndex) => {
    const remoteContent = example.exampleId ? remote.get(example.exampleId) : undefined;
    if (!remoteContent) {
      additions.push({ localIndex, content: stripExampleId(example.content) });
      return;
    }
    matched.add(example.exampleId!);
    if (isDeepStrictEqual(stripExampleId(example.content), stripExampleId(remoteContent))) {
      unchanged++;
    } else updates.push(example.content);
  });

  const deleteIds = [...remote.keys()].filter((id) => !matched.has(id));

  return { additions, updates, deleteIds, unchanged };
}

// stripExampleId drops the id before an add: the service assigns its own.
export function stripExampleId(content: DatasetExample): DatasetExample {
  const { [EXAMPLE_ID]: _id, ...rest } = content;
  return rest;
}

// applyExampleIds renders the local file with service-assigned ids attached to the
// rows that were added, leaving every other row untouched. `assignedIds` is
// positional: the nth id belongs to the nth addition. Without these ids the next
// sync cannot match the rows and would add them again as duplicates.
export function applyExampleIds(
  local: ParsedExample[],
  additions: Addition[],
  assignedIds: string[],
): string {
  if (assignedIds.length !== additions.length) {
    throw new MalformedServiceResponseError(
      `Dataset service returned ${assignedIds.length} exampleIds for ` +
        `${additions.length} additions`,
      { meta: { expected: additions.length, received: assignedIds.length } },
    );
  }

  const uniqueIds = new Set<string>();
  assignedIds.forEach((id, index) => {
    if (typeof id !== "string" || id.trim() === "") {
      throw new MalformedServiceResponseError(
        `Dataset service returned an invalid exampleId for addition ${index + 1}`,
        { meta: { index } },
      );
    }
    if (uniqueIds.has(id)) {
      throw new MalformedServiceResponseError(
        `Dataset service returned duplicate exampleId "${id}"`,
        { meta: { exampleId: id, index } },
      );
    }
    uniqueIds.add(id);
  });

  const idByLocalIndex = new Map<number, string>();
  additions.forEach((addition, i) => {
    idByLocalIndex.set(addition.localIndex, assignedIds[i]!);
  });

  const lines = local.map((example, index) => {
    const assigned = idByLocalIndex.get(index);
    // Put exampleId first so the id is visible at the start of each line.
    return JSON.stringify(
      assigned === undefined
        ? example.content
        : { [EXAMPLE_ID]: assigned, ...stripExampleId(example.content) },
    );
  });

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
