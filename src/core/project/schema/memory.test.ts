import { describe, expect, it } from "bun:test";
import { MemorySchema, MemoryStrategySchema } from "./memory";
describe("memory custom validation", () => {
  it("keeps deprecated and current namespace fields mutually exclusive", () => {
    const result = MemoryStrategySchema.safeParse({
      type: "SEMANTIC",
      namespaces: ["/legacy"],
      namespaceTemplates: ["/current"],
    });
    expect(result.success).toBe(false);
  });
  it("requires valid episodic reflection namespace relationships", () => {
    expect(
      MemoryStrategySchema.safeParse({
        type: "EPISODIC",
        namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
      }).success,
    ).toBe(false);
    expect(
      MemoryStrategySchema.safeParse({
        type: "SEMANTIC",
        reflectionNamespaceTemplates: ["/users/{actorId}"],
      }).success,
    ).toBe(false);
    expect(
      MemoryStrategySchema.safeParse({
        type: "EPISODIC",
        namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
        reflectionNamespaceTemplates: ["/unrelated"],
      }).success,
    ).toBe(false);
    expect(
      MemoryStrategySchema.safeParse({
        type: "EPISODIC",
        namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
        reflectionNamespaceTemplates: ["/episodes/{actorId}"],
      }).success,
    ).toBe(true);
  });
  it("rejects duplicate strategy types and indexed keys", () => {
    expect(
      MemorySchema.safeParse({
        name: "memory",
        eventExpiryDuration: 30,
        strategies: [{ type: "SEMANTIC" }, { type: "SEMANTIC" }],
      }).success,
    ).toBe(false);
    expect(
      MemorySchema.safeParse({
        name: "memory",
        eventExpiryDuration: 30,
        strategies: [{ type: "SEMANTIC" }],
        indexedKeys: [
          { key: "orderId", type: "STRING" },
          { key: "orderId", type: "STRING" },
        ],
      }).success,
    ).toBe(false);
  });
  it("requires a long-term strategy when indexed keys are configured", () => {
    const result = MemorySchema.safeParse({
      name: "memory",
      eventExpiryDuration: 30,
      indexedKeys: [{ key: "orderId", type: "STRING" }],
    });
    expect(result.success).toBe(false);
  });
});
