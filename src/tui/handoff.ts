import type { Core } from "../handlers/types";
import type { AppIO } from "../io";
import { contextKey, type Context } from "../router";

export type TuiHandoffResult = {
  resumePath?: string;
};

export type TuiHandoff = (input: {
  ctx: Context;
  core: Core;
  io: AppIO;
}) => Promise<TuiHandoffResult | void>;

export class TuiHandoffController {
  private handoff?: TuiHandoff;

  request(handoff: TuiHandoff): void {
    if (this.handoff) throw new Error("TUI handoff already requested");
    this.handoff = handoff;
  }

  take(): TuiHandoff | undefined {
    const handoff = this.handoff;
    this.handoff = undefined;
    return handoff;
  }
}

export const TuiHandoffKey = contextKey<TuiHandoffController>("tui.handoff");
