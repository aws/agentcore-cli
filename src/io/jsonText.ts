// stringifyJson is JSON.stringify that also accepts BigInt, written as a JSON
// number with every digit. The AWS SDK decodes integers beyond 2^53 inside
// document members to BigInt when the runtime's JSON.parse exposes source text
// (Bun does, Node 20 does not), and plain JSON.stringify throws on them.
//
// A replacer cannot return raw JSON, and JSON.rawJSON is missing from Node 20,
// so each BigInt is first written as a marked string and the marked strings are
// then unquoted. The marker is chosen so that it occurs nowhere in the output
// without BigInts, which means no real string can be mistaken for one. Output
// for a value with no BigInt is exactly what JSON.stringify returns.
export function stringifyJson(value: unknown, space?: number): string {
  let hasBigInt = false;
  const plain = JSON.stringify(
    value,
    (_key, val: unknown) => {
      if (typeof val !== "bigint") return val;
      hasBigInt = true;
      return val.toString();
    },
    space,
  );
  if (!hasBigInt) return plain;

  let marker = "bigint:";
  while (plain.includes(marker)) marker += "_";
  const marked = JSON.stringify(
    value,
    (_key, val: unknown) => (typeof val === "bigint" ? `${marker}${val.toString()}` : val),
    space,
  );
  return marked.replace(new RegExp(`"${marker}(-?\\d+)"`, "g"), "$1");
}
