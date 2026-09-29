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
  decimal?: boolean;
}

function validateEntry(
  value: string,
  { label, required, schema, number = false, decimal = false }: ValidateOptions,
): string | undefined {
  if (value.trim() === "") return required ? `${label} is required` : undefined;
  if (number && !/^\d+$/.test(value)) return `${label} must be a whole number`;
  if (decimal && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return `${label} must be a number`;
  }
  if (!schema) return undefined;
  return firstIssue(schema, number || decimal ? Number(value) : value);
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
  decimal?: boolean;
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
  decimal = false,
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

    const issue = validateEntry(value, { label, required, schema, number, decimal });
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
              ? validateEntry(next, { label, required, schema, number, decimal })
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
      selectedIndex={index}
    />
  );
}

export type ResourceChoiceFieldProps<T> = ChoiceFieldProps<T> & {
  // What the step says when the project has none of the resource yet: what is
  // missing, and (in the hint) the command that adds one.
  emptyMessage: string;
  emptyHint?: string;
};

// ResourceChoiceField is a ChoiceField whose options come from the project
// spec. What it adds is the empty state: a project without the resource is the
// most likely first run, and the step should say what to add and let esc leave
// — to the add menu when this is the first step — rather than draw an empty list.
export function ResourceChoiceField<T>({
  emptyMessage,
  emptyHint,
  ...choice
}: ResourceChoiceFieldProps<T>) {
  if (choice.choices.length === 0) {
    return <ResourceEmptyState message={emptyMessage} hint={emptyHint} />;
  }
  return <ChoiceField {...choice} />;
}

export type ResourceEmptyStateProps = {
  message: string;
  hint?: string;
};

// ResourceEmptyState is the step a project without the resource lands on. It is
// exported for compound fields over a resource list — one that opens an input
// under the chosen row, say — which cannot be a ResourceChoiceField but should
// look the same when there is nothing to choose.
export function ResourceEmptyState({ message, hint }: ResourceEmptyStateProps) {
  const { back } = useWizard();

  // Nothing to choose, so enter has nothing to do; the footer offers esc only.
  useKeyHints([]);

  useInput((_input, key) => {
    if (key.escape) back();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.text}>{message}</Text>
      {hint !== undefined && <Text color={theme.colors.muted}>{hint}</Text>}
    </Box>
  );
}

export type RevealedInput<T> = {
  // opensFor says which rows have the follow-up: enter on one of them opens the
  // input; on any other row, enter continues.
  opensFor: (value: T) => boolean;
  // label names the value in validation messages ("<label> is required").
  label: string;
  // name is the heading over the input and help the line under it, as on a
  // FormTextInput.
  name: string;
  help?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  schema?: z.ZodType;
};

export type RevealChoiceFieldProps<T> = ChoiceFieldProps<T> & {
  input: RevealedInput<T>;
};

// RevealChoiceField is a ChoiceField where some rows have a follow-up question:
// enter on such a row opens one text input under the rows, the way the harness
// model step opens a model ID. The rows keep showing the value while the input
// has focus; esc or up returns to them; enter on the input validates it the way
// a TextField would and continues. A question that exists for one row only is
// asked there rather than as a step of its own.
export function RevealChoiceField<T>({
  help = "",
  choices,
  value,
  onChange,
  input,
}: RevealChoiceFieldProps<T>) {
  const { advance, back, isLast } = useWizard();
  const found = choices.findIndex((choice) => choice.value === value);
  const index = found === -1 ? 0 : found;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "enter", label: isLast ? "submit" : "continue" },
  ]);

  useInput((_input, key) => {
    if (!editing) {
      if (key.escape) {
        back();
        return;
      }
      if (key.upArrow || key.downArrow) {
        const nextIndex = key.upArrow
          ? Math.max(0, index - 1)
          : Math.min(choices.length - 1, index + 1);
        onChange(choices[nextIndex]!.value);
        setError(undefined);
        return;
      }
      if (key.return) {
        // With nothing to choose there is nothing to open; continue rather than
        // throw, though callers show a ResourceEmptyState before it comes to that.
        const current = choices[index];
        if (current !== undefined && input.opensFor(current.value)) setEditing(true);
        else advance();
      }
      return;
    }

    if (key.escape || key.upArrow) {
      setEditing(false);
      setError(undefined);
      return;
    }
    if (!key.return) return;

    const issue = validateEntry(input.value, {
      label: input.label,
      required: input.required ?? false,
      schema: input.schema,
    });
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      <FormRadioGroup
        name=""
        helpText={help}
        options={choices.map((choice) => ({
          label: choice.label,
          description: choice.description ?? "",
        }))}
        focusedIndex={editing ? undefined : index}
        selectedIndex={index}
      />
      {editing && (
        <FormTextInput
          name={input.name}
          helpText={input.help ?? ""}
          placeholder={input.placeholder ?? ""}
          errorText=""
          value={input.value}
          onChange={(next) => {
            input.onChange(next);
            setError(undefined);
          }}
        />
      )}
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
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
