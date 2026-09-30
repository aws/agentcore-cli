import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type z from "zod";
import { FormTextInput } from "../FormTextInput";
import { FormTextArea } from "../FormTextArea";
import { FormRadioGroup } from "../FormRadioGroup";
import { FormCheckboxMultiSelect } from "../FormCheckboxMultiSelect";
import { KeyValueTable } from "../KeyValueTable";
import { darkTheme } from "../ui/_core.js";
import { useKeyHints, useWizard } from "./context";

const theme = darkTheme;

// firstIssue renders the schema's own message, so a wizard rejects exactly what
// the flag-driven path rejects and says the same thing about it. Exported for
// compound fields that validate a revealed input against a flag's schema.
export function firstIssue(schema: z.ZodType, value: unknown): string | undefined {
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
  // number validates the number the answer parses to rather than the text, so a
  // numeric flag's own schema can bound the field.
  number?: boolean;
  decimal?: boolean;
  // json parses the value before the schema sees it, so a malformed blob is
  // reported as bad JSON rather than as a shape the schema cannot read.
  json?: boolean;
}

function validateEntry(
  value: string,
  { label, required, schema, number = false, decimal = false, json = false }: ValidateOptions,
): string | undefined {
  if (value.trim() === "") return required ? `${label} is required` : undefined;
  if (number && !/^\d+$/.test(value)) return `${label} must be a whole number`;
  if (decimal && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return `${label} must be a number`;
  }
  let parsed: unknown = number || decimal ? Number(value) : value;
  if (json) {
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      return `${label} is not valid JSON: ${(cause as Error).message}`;
    }
  }
  if (!schema) return undefined;
  return firstIssue(schema, parsed);
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

export interface TextAreaFieldProps {
  // label names the value in validation messages ("<label> is required").
  label: string;
  help?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  // schema validates the parsed JSON when `json` is set, and the raw text
  // otherwise — the same rules TextField applies.
  schema?: z.ZodType;
  // json parses the value before validating it and reports malformed JSON.
  json?: boolean;
  // example is a dimmed line above the editor, kept on screen while the user
  // types. A placeholder cannot do this job — it disappears on the first
  // keystroke, exactly when a fiddly value most needs a shape to copy from.
  example?: string;
}

// TextAreaField collects a value that arrives multi-line: an agent's
// instructions, pasted configuration. Enter inserts a newline and ctrl+d
// continues, which is what the hand-written harness wizard's prompt step
// already did — the cost of multi-line paste is that enter can no longer mean
// "continue". The one exception is an empty value: FormTextArea leaves that
// enter alone, so it answers the step the way enter does on every other field,
// which for a required value is the message saying so.
export function TextAreaField({
  label,
  help = "",
  placeholder = "",
  value,
  onChange,
  required = false,
  schema,
  json = false,
  example,
}: TextAreaFieldProps) {
  const { advance, back, isLast } = useWizard();
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "enter", label: "newline" },
    { key: "ctrl+d", label: isLast ? "submit" : "continue" },
  ]);

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }
    const continues = (key.ctrl && input === "d") || (key.return && value === "");
    if (!continues) return;

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
      {example !== undefined && <Text color={theme.colors.muted}>{`for example  ${example}`}</Text>}
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

export type TextInputSpec = {
  key: string;
  // label heads the input and names it in validation messages.
  label: string;
  help?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  schema?: z.ZodType;
  // number rejects anything but digits before the schema sees the value.
  number?: boolean;
};

export type MultiTextFieldProps = {
  inputs: TextInputSpec[];
};

// MultiTextField collects several short answers that belong together — a branch
// and the commit message that lands on it, say — as stacked inputs on one step,
// the way the online-insight settings and the harness model step lay theirs
// out. One input has focus at a time: enter validates it the way a TextField
// would and moves down, the arrows move without validating, and enter on the
// last input re-checks every input (so one skipped with the arrows cannot slip
// through) before continuing. Esc goes back a step.
export function MultiTextField({ inputs }: MultiTextFieldProps) {
  const { advance, back, isLast } = useWizard();
  const [focused, setFocused] = useState(0);
  const [error, setError] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "enter", label: isLast ? "submit" : "continue" },
  ]);

  const issueOf = (input: TextInputSpec) =>
    validateEntry(input.value, {
      label: input.label,
      required: input.required ?? false,
      schema: input.schema,
      number: input.number ?? false,
    });

  useInput((_input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setFocused(Math.max(0, focused - 1));
      setError(undefined);
      return;
    }
    if (key.downArrow) {
      setFocused(Math.min(inputs.length - 1, focused + 1));
      setError(undefined);
      return;
    }
    if (!key.return) return;

    const current = inputs[focused];
    if (current === undefined) return;
    const issue = issueOf(current);
    if (issue !== undefined) {
      setError(issue);
      return;
    }
    if (focused < inputs.length - 1) {
      setFocused(focused + 1);
      setError(undefined);
      return;
    }
    const skipped = inputs.findIndex((input) => issueOf(input) !== undefined);
    if (skipped !== -1) {
      setFocused(skipped);
      setError(issueOf(inputs[skipped]!));
      return;
    }
    setError(undefined);
    advance();
  });

  return (
    <Box flexDirection="column">
      {inputs.map((input, index) => (
        <FormTextInput
          key={input.key}
          name={input.label}
          helpText={input.help ?? ""}
          placeholder={input.placeholder ?? ""}
          errorText=""
          value={input.value}
          onChange={(next) => {
            input.onChange(next);
            setError(undefined);
          }}
          focused={index === focused}
        />
      ))}
      {error !== undefined && <Text color={theme.colors.error}>{error}</Text>}
    </Box>
  );
}

export interface MultiChoiceFieldProps<T> {
  help?: string;
  choices: Choice<T>[];
  value: T[];
  onChange: (value: T[]) => void;
  minSelections?: number;
  minSelectionsMessage?: string;
}

// MultiChoiceField answers with a subset of its choices, always ordered as the
// choices are, so the review and the resource read the same either way.
export function MultiChoiceField<T>({
  help = "",
  choices,
  value,
  onChange,
  minSelections = 0,
  minSelectionsMessage,
}: MultiChoiceFieldProps<T>) {
  const { advance, back, isLast } = useWizard();
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string>();

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
      setError(undefined);
      return;
    }
    if (key.return) {
      if (value.length < minSelections) {
        setError(
          minSelectionsMessage ??
            `Select at least ${minSelections} ${minSelections === 1 ? "option" : "options"}`,
        );
        return;
      }
      setError(undefined);
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

export function promptPreview(prompt: string): string {
  const lines = prompt.split("\n");
  const [first = ""] = lines;
  const shown = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return lines.length === 1 ? shown : `${shown} · ${lines.length} lines`;
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
