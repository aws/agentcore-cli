import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import z from "zod";
import type { StartBatchEvaluationResponse } from "@aws-sdk/client-bedrock-agentcore";
import type { EvaluatorSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import {
  Step,
  Summary,
  TextField,
  Wizard,
  useKeyHints,
  useWizard,
} from "../../../../components/wizard";
import { darkTheme, glyphs } from "../../../../components/ui/_core.js";

const theme = darkTheme;

const BREADCRUMB = ["agentcore", "eval", "batch-evaluation", "evaluate"];
const DESCRIPTION = "evaluate existing sessions service-side";
const MENU = "/agentcore/eval/batch-evaluation";

// The service caps a name to non-empty; uniqueness is enforced server-side, so
// the field only guards against an empty submission.
const NameSchema = z.string().min(1);
const LookbackSchema = z.coerce.number().int().positive();

interface EvaluateFormValues {
  name: string;
  agent: string;
  lookbackDays: string;
  evaluatorIds: string[];
}

export function BatchEvaluationEvaluateScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  const opts = coreOptsFromCtx(ctx);
  const [values, setValues] = useState<EvaluateFormValues>({
    name: "",
    agent: "",
    lookbackDays: "7",
    evaluatorIds: [],
  });
  const [result, setResult] = useState<StartBatchEvaluationResponse>();
  const set = (update: Partial<EvaluateFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  // First page only for now; a paged picker is a follow-up (see design doc).
  // ponytail: 100-item cap, add pagination if accounts routinely exceed it.
  const evaluators = useQuery({
    queryKey: ["evaluators", opts.region],
    queryFn: () => core.eval.listEvaluators(undefined, 100, opts),
  });

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(MENU)}
      onSubmit={async () => {
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - Number(values.lookbackDays) * 86_400_000);
        const response = await core.eval.startBatchEvaluation(
          {
            name: values.name,
            evaluatorIds: values.evaluatorIds,
            source: { origin: "agent", agent: values.agent, window: { startTime, endTime } },
          },
          opts,
        );
        setResult(response);
        return response;
      }}
      runningLabel={`starting batch evaluation ${values.name}…`}
      successLabel={
        result
          ? `batch evaluation '${result.batchEvaluationName}' started (${result.status})`
          : "batch evaluation started"
      }
      successNextSteps={
        result?.batchEvaluationId
          ? [`agentcore eval batch-evaluation get ${result.batchEvaluationId}`]
          : undefined
      }
      onDone={() => navigate(MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="name your batch evaluation">
        <TextField
          label="Name"
          placeholder="my-batch-evaluation"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={NameSchema}
        />
      </Step>

      <Step stepKey="source" prompt="point at the agent whose sessions to evaluate">
        <TextField
          label="Agent (harness or runtime ID)"
          placeholder="my_agent"
          value={values.agent}
          onChange={(agent) => set({ agent })}
          required
        />
      </Step>

      <Step stepKey="lookback" prompt="evaluate sessions from the last N days">
        <TextField
          label="Lookback (days)"
          placeholder="7"
          value={values.lookbackDays}
          onChange={(lookbackDays) => set({ lookbackDays })}
          required
          schema={LookbackSchema}
          live
        />
      </Step>

      <Step stepKey="evaluators" prompt="apply one or more evaluators">
        <EvaluatorMultiSelect
          evaluators={evaluators.data?.evaluators ?? []}
          loading={evaluators.isPending}
          error={evaluators.isError ? (evaluators.error as Error) : undefined}
          selected={values.evaluatorIds}
          onChange={(evaluatorIds) => set({ evaluatorIds })}
        />
      </Step>

      <Step stepKey="review" prompt="this batch evaluation will be started">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

function summaryOf(values: EvaluateFormValues): Record<string, string> {
  return {
    name: values.name,
    source: `agent · ${values.agent}`,
    lookback: `last ${values.lookbackDays} days`,
    evaluators: values.evaluatorIds.join(", "),
  };
}

// EvaluatorMultiSelect is a compound wizard field: the shell ships no
// multi-select, so this owns its own useInput — up/down move the cursor, space
// toggles, enter advances once at least one evaluator is checked.
function EvaluatorMultiSelect({
  evaluators,
  loading,
  error,
  selected,
  onChange,
}: {
  evaluators: EvaluatorSummary[];
  loading: boolean;
  error?: Error;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { advance, back } = useWizard();
  const [cursor, setCursor] = useState(0);
  const [issue, setIssue] = useState<string>();

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "space", label: "toggle" },
    { key: "enter", label: "continue" },
  ]);

  const withId = evaluators.filter((evaluator) => evaluator.evaluatorId);
  // Clamp on read rather than in the arrow setters so the handler never depends
  // on a stale list length (the query resolves after the field first mounts).
  const active = withId.length === 0 ? 0 : Math.min(Math.max(cursor, 0), withId.length - 1);

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }
    if (key.upArrow) {
      setCursor(Math.max(0, active - 1));
      return;
    }
    if (key.downArrow) {
      setCursor(Math.min(withId.length - 1, active + 1));
      return;
    }
    if (input === " ") {
      const id = withId[active]?.evaluatorId;
      if (!id) return;
      onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
      setIssue(undefined);
      return;
    }
    if (key.return) {
      if (selected.length === 0) {
        setIssue("select at least one evaluator");
        return;
      }
      advance();
    }
  });

  if (loading) return <Text color={theme.colors.muted}>loading evaluators…</Text>;
  if (error) return <Text color={theme.colors.error}>{error.message}</Text>;
  if (withId.length === 0) {
    return <Text color={theme.colors.muted}>no evaluators found in this Region</Text>;
  }

  // Window the list so a long account roster doesn't push the footer off-screen;
  // the cursor stays centred until it reaches either end.
  const WINDOW = 8;
  const start = Math.max(0, Math.min(active - Math.floor(WINDOW / 2), withId.length - WINDOW));
  const visible = withId.slice(start, start + WINDOW);

  return (
    <Box flexDirection="column">
      {visible.map((evaluator, i) => {
        const id = evaluator.evaluatorId!;
        const checked = selected.includes(id);
        const focused = start + i === active;
        return (
          <Text key={id} color={focused ? theme.colors.focus : theme.colors.text}>
            {focused ? glyphs.pointer : " "} [{checked ? glyphs.check : " "}]{" "}
            {evaluator.evaluatorName ?? id}
          </Text>
        );
      })}
      <Box marginTop={1}>
        {issue ? (
          <Text color={theme.colors.error}>{issue}</Text>
        ) : (
          <Text color={theme.colors.muted}>
            {selected.length} selected · {active + 1}/{withId.length}
          </Text>
        )}
      </Box>
    </Box>
  );
}
