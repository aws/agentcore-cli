import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type z from "zod";
import { FormTextInput } from "../FormTextInput";
import { FormRadioGroup } from "../FormRadioGroup";
import { FormCheckboxMultiSelect } from "../FormCheckboxMultiSelect";
import { FormTextArea } from "../FormTextArea";
import { KeyValueTable } from "../KeyValueTable";
import { darkTheme } from "../ui/_core.js";
import { useKeyHints, useWizard } from "./context";

const theme = darkTheme;

// Every field owns the key handling for its own step — esc goes back, enter
// advances, arrows move — so a screen never writes that boilerplate again.

// firstIssue renders the schema's own message, so the wizard rejects exactly
// what the flag-driven path rejects and says the same thing about it. The issue
// path is prefixed when there is one: for a nested value — a component inside a
// components map, say — "expected object, received string" alone does not say
// which key is wrong.
function firstIssue(schema: z.ZodType, value: unknown): string | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  if (!issue) return "invalid value";
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

interface ValidateOptions {
  label: string;
  required: boolean;
  schema?: z.ZodType;
  // json parses the value before the schema sees it, so a malformed blob is
  // reported as bad JSON rather than as a shape the schema cannot read.
  json?: boolean;
}

// validateEntry returns the message that should block the step, or undefined to
// let it advance. Shared by the single-line and multi-line fields so both refuse
// the same input for the same stated reason.
function validateEntry(
  value: string,
  { label, required, schema, json = false }: ValidateOptions,
): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return required ? `${label} is required` : undefined;

  let parsed: unknown = trimmed;
  if (json) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      return `${label} is not valid JSON: ${(cause as Error).message}`;
    }
  }
  return schema ? firstIssue(schema, parsed) : undefined;
}

export interface TextFieldProps {
  // label names the value in validation messages ("<label> is required").
  // It is not rendered: the <Step> already asks the question, and repeating
  // it as a heading only adds a line to read.
  label: string;
  // help is the one line under the control, for what the question cannot
  // carry — a range, a service limit, what an empty answer means. Omit it
  // rather than restate the question.
  help?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  // required blocks advancing while the value is blank. Flag schemas are all
  // `.optional()` by convention (Commander must not reject a bare command
  // before the TUI middleware can open a screen), so required-ness is stated
  // here the same way the handlers state it in their own bodies.
  required?: boolean;
  // schema validates the trimmed value before advancing. Pass the schema the
  // flag declares.
  schema?: z.ZodType;
  // json parses the value before validating it. A JSON flag belongs here rather
  // than in TextAreaField unless the value is genuinely prose: JSON is valid on
  // one line, and this field can be edited in place.
  json?: boolean;
  // example is a dimmed line under `help`, kept on screen while the user types.
  // A placeholder cannot do this job — it disappears on the first keystroke,
  // exactly when a fiddly value most needs something to copy the shape from.
  example?: string;
}

export function TextField({
  label,
  help = "",
  placeholder = "",
  value,
  onChange,
  required = false,
  schema,
  json = false,
  example,
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

    const issue = validateEntry(value, { label, required, schema, json });
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      {/* The example sits above the input rather than inside it, so it survives
          the first keystroke and stays there to be copied from. */}
      {example !== undefined && (
        <Box flexDirection="column">
          {help !== "" && <Text color={theme.colors.muted}>{help}</Text>}
          <Text color={theme.colors.muted}>{`for example  ${example}`}</Text>
        </Box>
      )}
      <FormTextInput
        name=""
        helpText={example === undefined ? help : ""}
        placeholder={placeholder}
        errorText=""
        value={value}
        onChange={(next) => {
          onChange(next);
          setError(undefined);
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
  // help is the one line under the options, for what the question and the
  // per-option descriptions cannot carry between them. Usually omitted.
  help?: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}

// ChoiceField is a single-choice step. The arrow arithmetic here replaces the
// copy of it in each of the hand-written wizards. It takes no `label`: one of
// the choices is always selected, so there is no validation message to name.
export function ChoiceField<T>({ help = "", choices, value, onChange }: ChoiceFieldProps<T>) {
  const { advance, back, isLast } = useWizard();

  useKeyHints([
    { key: "↑↓", label: "choose" },
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
      selectedIndex={index}
    />
  );
}

export interface MultiChoiceFieldProps<T> {
  // label names the value in validation messages ("<label> is required").
  // It is not rendered: the <Step> already asks the question, and repeating
  // it as a heading only adds a line to read.
  label: string;
  // help is the one line under the control, for what the question cannot
  // carry — a range, a service limit, what an empty answer means. Omit it
  // rather than restate the question.
  help?: string;
  choices: Choice<T>[];
  value: T[];
  onChange: (value: T[]) => void;
  // requireOne blocks advancing on an empty selection.
  requireOne?: boolean;
}

export function MultiChoiceField<T>({
  label,
  help = "",
  choices,
  value,
  onChange,
  requireOne = false,
}: MultiChoiceFieldProps<T>) {
  const { advance, back, isLast } = useWizard();
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "move" },
    { key: "space", label: "toggle" },
    { key: "enter", label: isLast ? "submit" : "continue" },
  ]);

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(choices.length - 1, c + 1));
      return;
    }
    if (input === " ") {
      const choice = choices[cursor];
      if (!choice) return;
      setError(undefined);
      onChange(
        value.includes(choice.value)
          ? value.filter((selected) => selected !== choice.value)
          : [...value, choice.value],
      );
      return;
    }
    if (key.return) {
      if (requireOne && value.length === 0) {
        setError(`select at least one ${label}`);
        return;
      }
      advance();
    }
  });

  return (
    <Box flexDirection="column">
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
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

export interface TextAreaFieldProps {
  // label names the value in validation messages ("<label> is required").
  // It is not rendered: the <Step> already asks the question, and repeating
  // it as a heading only adds a line to read.
  label: string;
  // help is the one line under the control, for what the question cannot
  // carry — a range, a service limit, what an empty answer means. Omit it
  // rather than restate the question.
  help?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  // schema validates the parsed JSON when `json` is set, or the raw text
  // otherwise.
  schema?: z.ZodType;
  // json parses the value before validating, and reports malformed JSON.
  json?: boolean;
}

// TextAreaField collects multi-line text — a JSON blob, a system prompt.
// FormTextArea spends enter on newlines, so ctl+d advances, matching the prompt
// step in HarnessWizard.
export function TextAreaField({
  label,
  help = "",
  placeholder = "",
  value,
  onChange,
  required = false,
  schema,
  json = false,
}: TextAreaFieldProps) {
  const { advance, back, isLast } = useWizard();
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "enter", label: "newline" },
    { key: "ctl+d", label: isLast ? "submit" : "continue" },
  ]);

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (!(key.ctrl && input === "d")) return;

    const issue = validateEntry(value, { label, required, schema, json });
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      <FormTextArea
        name=""
        helpText={help}
        placeholder={placeholder}
        value={value}
        onChange={(next) => {
          onChange(next);
          setError(undefined);
        }}
      />
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

export interface SummaryProps {
  // items is the review table: what will be created, and with what settings.
  items: Record<string, string>;
}

// Summary is the review step. It sits last, so its enter submits.
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
    <Box flexDirection="column">
      <Box
        borderStyle="single"
        borderColor={theme.colors.border}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
      >
        <KeyValueTable items={items} />
      </Box>
    </Box>
  );
}
