import { test, expect, describe } from "bun:test";
import { renderJsonTemplate } from "./template";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("renderJsonTemplate", () => {
  test("substitutes {input} inside a string value", () => {
    const out = decode(renderJsonTemplate('{"prompt":"{input}"}', { input: "hello" }));
    expect(JSON.parse(out)).toEqual({ prompt: "hello" });
  });

  test("JSON-escapes substituted values (quotes, newlines don't break the payload)", () => {
    const out = renderJsonTemplate('{"prompt":"{input}"}', { input: 'a "quote"\nline' });
    expect(JSON.parse(decode(out))).toEqual({ prompt: 'a "quote"\nline' });
  });

  test("substitutes nested + array positions", () => {
    const out = renderJsonTemplate('{"messages":[{"role":"user","content":"{input}"}]}', {
      input: "hi",
    });
    expect(JSON.parse(decode(out))).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  test("supports arbitrary keys, leaves unknown placeholders intact", () => {
    const out = renderJsonTemplate('{"m":"{model}","p":"{input}"}', { input: "x" });
    expect(JSON.parse(decode(out))).toEqual({ m: "{model}", p: "x" });
  });

  test("rejects invalid JSON template", () => {
    expect(() => renderJsonTemplate("{not json", { input: "x" })).toThrow(/valid JSON/);
  });
});
