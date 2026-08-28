import Handlebars from "handlebars";
import type { TemplateRenderer } from "./types";

/** An implementation of {@link TemplateRenderer} that leverages handlebars to substitute placeholders in the given string **/
export class HandlebarsTemplateRenderer implements TemplateRenderer {
  private readonly hbs: typeof Handlebars;

  constructor() {
    this.hbs = Handlebars.create();
    // taken from https://github.com/aws/agentcore-cli/blob/cad94708aeaaa4c7d3e17ecac423453172f3fa86/src/cli/templates/render.ts#L5
    this.hbs.registerHelper("eq", (a: unknown, b: unknown) => a === b);
    this.hbs.registerHelper(
      "includes",
      (arr: unknown[], val: unknown) => Array.isArray(arr) && arr.includes(val),
    );
    this.hbs.registerHelper(
      "some",
      (arr: unknown[], key: string) =>
        Array.isArray(arr) &&
        arr.some(
          (value) =>
            value !== null &&
            typeof value === "object" &&
            key in value &&
            Boolean((value as Record<string, unknown>)[key]),
        ),
    );
    this.hbs.registerHelper("or", (...args: unknown[]) => {
      for (let i = 0; i < args.length - 1; i++) if (args[i]) return true;
      return false;
    });
    this.hbs.registerHelper("snakeCase", (str: string) =>
      str.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase(),
    );
    this.hbs.registerHelper(
      "safeJson",
      (value: unknown) => new Handlebars.SafeString(JSON.stringify(value)),
    );
    this.hbs.registerHelper(
      "pyJsonStr",
      (value: unknown) => new Handlebars.SafeString(JSON.stringify(JSON.stringify(value))),
    );
    this.hbs.registerHelper("escapePyStr", (value: unknown) => {
      const str = typeof value === "string" ? value : "";
      return new Handlebars.SafeString(str.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"'));
    });
  }

  render(template: string, context: Record<string, unknown>): string {
    return this.hbs.compile(template, { noEscape: true })(context);
  }
}
