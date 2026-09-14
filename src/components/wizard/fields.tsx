import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type z from "zod";
import { FormTextInput } from "../FormTextInput";
import { FormRadioGroup } from "../FormRadioGroup";
import { FormCheckboxMultiSelect } from "../FormCheckboxMultiSelect";
import { KeyValueTable } from "../KeyValueTable";
import { darkTheme } from "../ui/_core.js";
import { useKeyHints, useWizard } from "./context";

const theme = darkTheme;

function firstIssue(schema: z.ZodType, value: unknown): string | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0]!;
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

interface ValidateOptions {
  label: string;
  required: boolean;
  schema?: z.ZodType;
  // number validates the number the answer parses to rather than the text, so a
  // numeric flag's own schema can bound the field.
  number?: boolean;
}

function validateEntry(
  value: string,
  { label, required, schema, number = false }: ValidateOptions,
): string | undefined {
  if (value.trim() === "") return required ? `${label} is required` : undefined;
  if (number && !/^\d+$/.test(value)) return `${label} must be a whole number`;
  if (!schema) return undefined;
  return firstIssue(schema, number ? Number(value) : value);
}

export interface TextFieldProps {
  label: string;
  help?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  schema?: z.ZodType;
  live?: boolean;
  number?: boolean;
}

export function TextField({
  label,
  help = "",
  placeholder = "",
  value,
  onChange,
  required = false,
  schema,
  live = false,
  number = false,
}: TextFieldProps) {
  const { advance, back, isLast } = useWizard();
  const [error, setError] = useState<string>();

  useKeyHints([{ key: "enter", label: isLast ? "submit" : "continue" }]);

  useInput((_input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (!key.return) return;

    const issue = validateEntry(value, { label, required, schema, number });
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      <FormTextInput
        name=""
        helpText={help}
        placeholder={placeholder}
        errorText=""
        value={value}
        onChange={(next) => {
          onChange(next);
          setError(
            live && next.trim() !== ""
              ? validateEntry(next, { label, required, schema, number })
              : undefined,
          );
        }}
      />
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

export interface Choice<T> {
  value: T;
  label: string;
  description?: string;
}

export interface ChoiceFieldProps<T> {
  help?: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function ChoiceField<T>({ help = "", choices, value, onChange }: ChoiceFieldProps<T>) {
  const { advance, back, isLast } = useWizard();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "enter", label: isLast ? "submit" : "continue" },
  ]);

  const found = choices.findIndex((choice) => choice.value === value);
  const index = found === -1 ? 0 : found;

  useInput((_input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      onChange(choices[Math.max(0, index - 1)]!.value);
      return;
    }
    if (key.downArrow) {
      onChange(choices[Math.min(choices.length - 1, index + 1)]!.value);
      return;
    }
    if (key.return) advance();
  });

  return (
    <FormRadioGroup
      name=""
      helpText={help}
      options={choices.map((choice) => ({
        label: choice.label,
        description: choice.description ?? "",
      }))}
      focusedIndex={index}
    />
  );
}

export interface MultiChoiceFieldProps<T> {
  help?: string;
  choices: Choice<T>[];
  value: T[];
  onChange: (value: T[]) => void;
}

// MultiChoiceField answers with a subset of its choices, always ordered as the
// choices are, so the review and the resource read the same either way.
export function MultiChoiceField<T>({
  help = "",
  choices,
  value,
  onChange,
}: MultiChoiceFieldProps<T>) {
  const { advance, back, isLast } = useWizard();
  const [cursor, setCursor] = useState(0);

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "space", label: "toggle" },
    { key: "enter", label: isLast ? "submit" : "continue" },
  ]);

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((current) => Math.min(choices.length - 1, current + 1));
      return;
    }
    if (input === " ") {
      const toggled = choices[cursor]!.value;
      const selected = value.includes(toggled)
        ? value.filter((entry) => entry !== toggled)
        : [...value, toggled];
      onChange(
        choices.filter((choice) => selected.includes(choice.value)).map((choice) => choice.value),
      );
      return;
    }
    if (key.return) advance();
  });

  return (
    <FormCheckboxMultiSelect
      name=""
      helpText={help}
      options={choices.map((choice) => ({
        label: choice.label,
        description: choice.description ?? "",
        checked: value.includes(choice.value),
      }))}
      cursorIndex={cursor}
    />
  );
}

export interface SummaryProps {
  items: Record<string, string>;
}

export function Summary({ items }: SummaryProps) {
  const { advance, back } = useWizard();

  useKeyHints([{ key: "enter", label: "submit" }]);

  useInput((_input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.return) advance();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.colors.border}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
    >
      <KeyValueTable items={items} />
    </Box>
  );
}
