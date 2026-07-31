import { InputValidationError } from "../../../errors";

const INPUT_MARKER = "{{input}}";

function mediaType(contentType?: string): string {
  return (contentType || "application/json").split(";", 1)[0]!.trim().toLowerCase();
}

export function supportsPayloadTemplate(contentType?: string): boolean {
  const type = mediaType(contentType);
  return type === "application/json" || /^application\/[^/]+\+json$/.test(type);
}

function replaceInput(value: unknown, input: string): { value: unknown; replacements: number } {
  if (typeof value === "string") {
    const replacements = value.split(INPUT_MARKER).length - 1;
    return {
      value: value.replaceAll(INPUT_MARKER, input),
      replacements,
    };
  }
  if (Array.isArray(value)) {
    let replacements = 0;
    const next = value.map((item) => {
      const rendered = replaceInput(item, input);
      replacements += rendered.replacements;
      return rendered.value;
    });
    return { value: next, replacements };
  }
  if (value !== null && typeof value === "object") {
    let replacements = 0;
    const next = Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const rendered = replaceInput(item, input);
        replacements += rendered.replacements;
        return [key, rendered.value];
      }),
    );
    return { value: next, replacements };
  }
  return { value, replacements: 0 };
}

function parsePayloadTemplate(template: string): unknown {
  try {
    return JSON.parse(template);
  } catch (error) {
    throw new InputValidationError("Payload template must be valid JSON", { cause: error });
  }
}

export function renderPayloadTemplate(template: string, input: string): string {
  const rendered = replaceInput(parsePayloadTemplate(template), input);
  if (rendered.replacements === 0) {
    throw new InputValidationError(
      `Payload template must include "${INPUT_MARKER}" in a string value`,
    );
  }
  return JSON.stringify(rendered.value);
}

export function summarizePayloadTemplate(template: string): string {
  const lines = template.split("\n").length;
  return `${lines}-line template · ${JSON.stringify(parsePayloadTemplate(template))}`;
}
