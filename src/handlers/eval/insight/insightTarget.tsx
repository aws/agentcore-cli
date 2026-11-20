import z from "zod";
import { flag, type Flag } from "../../../router";

// Insight IDs are unique only within an application, so get and update need both.
export class InsightTarget {
  static readonly flags = [
    flag("application-name", "the application the Insight belongs to", z.string().min(1)),
    flag("id", "the ID of the Agent Insight", z.string().min(1)),
  ] as const;

  static resolve(flags: InsightTargetFlags): { applicationName: string; agentInsightId: string } {
    return { applicationName: flags["application-name"], agentInsightId: flags["id"] };
  }
}

export type InsightTargetFlags = {
  [F in (typeof InsightTarget.flags)[number] as F["name"]]: F extends Flag<string, infer T>
    ? T
    : never;
};
