import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type z from "zod";
import { FormTextInput } from "../FormTextInput";
import { FormRadioGroup } from "../FormRadioGroup";
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
}

function validateEntry(
  value: string,
  { label, required, schema }: ValidateOptions,
): string | undefined {
  if (value.trim() === "") return required ? `${label} is required` : undefined;
  return schema ? firstIssue(schema, value) : undefined;
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

    const issue = validateEntry(value, { label, required, schema });
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
              ? validateEntry(next, { label, required, schema })
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
