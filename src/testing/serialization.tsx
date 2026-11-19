// Date-safe JSON serialization for fixtures and golden files.
//
// AWS SDK responses carry live `Date` objects (e.g. a harness's `createdAt` /
// `updatedAt`), and screens/handlers depend on them being real Dates (see
// HarnessListScreen.toRow calling `.toISOString()`). Plain `JSON.stringify`
// turns a Date into a string and `JSON.parse` never turns it back, so a recorded
// fixture would replay a string where the code expects a Date. These helpers tag
// Dates on the way out and revive them on the way in so a round-trip is faithful.

// DATE_TAG marks a serialized Date. The shape is deliberately unlikely to collide
// with real API data.
const DATE_TAG = "$date";
// BIGINT_TAG marks a serialized BigInt, which the SDK returns for integers beyond
// 2^53 inside document members. A plain JSON number would replay as a rounded
// Number, so the digits are kept as a string.
const BIGINT_TAG = "$bigint";
const OBJECT_TAG = "$bigintObject";

type TaggedDate = {
  [DATE_TAG]: string;
};

type TaggedBigInt = {
  [BIGINT_TAG]: string;
};

type TaggedObject = {
  [OBJECT_TAG]: [string, { value?: unknown }][];
};

function isTaggedBigInt(value: unknown): value is TaggedBigInt {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    BIGINT_TAG in value &&
    typeof (value as TaggedBigInt)[BIGINT_TAG] === "string" &&
    /^-?\d+$/.test((value as TaggedBigInt)[BIGINT_TAG])
  );
}

function isTaggedObject(value: unknown): value is TaggedObject {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    OBJECT_TAG in value &&
    Array.isArray(value[OBJECT_TAG]) &&
    value[OBJECT_TAG].every(
      (entry: unknown) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "object" &&
        entry[1] !== null,
    )
  );
}

function isTaggedDate(value: unknown): value is TaggedDate {
  return (
    typeof value === "object" &&
    value !== null &&
    DATE_TAG in value &&
    typeof (value as TaggedDate)[DATE_TAG] === "string"
  );
}

// stringify serializes `value` to pretty JSON, encoding Date values as
// `{ "$date": "<iso>" }` and BigInt values as `{ "$bigint": "<digits>" }` so they
// survive the round-trip.
export function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    function (this: unknown, _key, val) {
      // `this[_key]` is the pre-`toJSON` value; a Date has already been coerced
      // to a string by the time it reaches `val`, so read the raw one back off
      // the parent to detect it.
      const raw = (this as Record<string, unknown>)[_key];
      if (raw instanceof Date) {
        return { [DATE_TAG]: raw.toISOString() };
      }
      if (typeof val === "bigint") return { [BIGINT_TAG]: val.toString() };
      // Store reserved keys as entry names so the reviver cannot treat user data as a tag.
      if (
        typeof val === "object" &&
        val !== null &&
        !Array.isArray(val) &&
        (Object.hasOwn(val, BIGINT_TAG) || Object.hasOwn(val, OBJECT_TAG))
      ) {
        return {
          [OBJECT_TAG]: Object.entries(val).map(([key, value]) => [key, { value }]),
        };
      }
      return val;
    },
    2,
  );
}

// parse is the inverse of stringify: it revives tagged Dates back into real Date
// instances and tagged BigInts back into BigInt.
export function parse<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, val) => {
    if (isTaggedDate(val)) return new Date(val[DATE_TAG]);
    if (isTaggedBigInt(val)) return BigInt(val[BIGINT_TAG]);
    if (isTaggedObject(val)) {
      return Object.fromEntries(
        val[OBJECT_TAG].filter(([, entry]) => Object.hasOwn(entry, "value")).map(([key, entry]) => [
          key,
          entry.value,
        ]),
      );
    }
    return val;
  }) as T;
}
