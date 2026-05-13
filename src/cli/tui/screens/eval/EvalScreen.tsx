import { handleListEvalRuns } from '../../../operations/eval';
import { getResultsPath } from '../../../operations/eval/storage';
import type { EvalEvaluatorResult, EvalRunResult } from '../../../operations/eval/types';
import { Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { STATUS_COLORS } from '../../theme';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatShortDate(timestamp: string): string {
  const d = new Date(timestamp);
  const mon = MONTHS[d.getMonth()];
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${mon} ${day} ${h12}:${m} ${ampm}`;
}

function formatFullDate(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function scoreColor(score: number): string {
  if (score >= 0.8) return 'green';
  if (score >= 0.5) return 'yellow';
  return 'red';
}

/** Strip "Builtin." prefix from evaluator names for display */
function shortEvalName(name: string): string {
  return name.replace(/^Builtin\./, '');
}

// Chrome: title(1) + padding(2) + panel border(2) + help text(2) + padding(2)
const CHROME_LINES = 9;

// ─────────────────────────────────────────────────────────────────────────────
// Windowing hook — shared by agent list and runs list
// ─────────────────────────────────────────────────────────────────────────────

function useWindowedList<T>(items: T[], selectedIndex: number, availableHeight: number, linesPerItem: number) {
  return useMemo(() => {
    const total = items.length;
    const baseMax = Math.max(1, Math.floor(availableHeight / linesPerItem));

    let start = 0;
    if (selectedIndex >= baseMax) {
      start = selectedIndex - baseMax + 1;
    }

    const hasUp = start > 0;
    const hasDown = start + baseMax < total;

    let reservedLines = 0;
    if (hasUp) reservedLines++;
    if (hasDown) reservedLines++;
    const maxItems = Math.max(1, Math.floor((availableHeight - reservedLines) / linesPerItem));

    if (selectedIndex >= maxItems) {
      start = selectedIndex - maxItems + 1;
    }

    return {
      visible: items.slice(start, start + maxItems),
      startIdx: start,
      showUp: start > 0,
      showDown: start + maxItems < total,
      countAbove: start,
      countBelow: Math.max(0, total - start - maxItems),
    };
  }, [items, selectedIndex, availableHeight, linesPerItem]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent picker view
// ─────────────────────────────────────────────────────────────────────────────

interface AgentGroup {
  agent: string;
  runCount: number;
  lastRun: string;
}

function AgentPickerView({
  groups,
  onSelect,
  onExit,
  availableHeight,
}: {
  groups: AgentGroup[];
  onSelect: (agent: string) => void;
  onExit: () => void;
  availableHeight: number;
}) {
  const nav = useListNavigation({
    items: groups,
    onSelect: item => onSelect(item.agent),
    onExit,
    isActive: true,
  });

  const { visible, showUp, showDown, countAbove, countBelow } = useWindowedList(
    groups,
    nav.selectedIndex,
    availableHeight,
    1
  );

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text bold>Select an agent</Text>
        <Text dimColor>
          {groups.length} agent{groups.length !== 1 ? 's' : ''} with eval runs
        </Text>
        <Box marginTop={1} flexDirection="column">
          {showUp && <Text dimColor> ↑ {countAbove} more</Text>}
          {visible.map((g, vIdx) => {
            const idx = (showUp ? countAbove : 0) + vIdx;
            const selected = idx === nav.selectedIndex;
            return (
              <Text key={g.agent}>
                <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {g.agent}
                </Text>
                <Text dimColor>
                  {'  '}
                  {g.runCount} run{g.runCount !== 1 ? 's' : ''}
                  {'  '}last: {formatShortDate(g.lastRun)}
                </Text>
              </Text>
            );
          })}
          {showDown && <Text dimColor> ↓ {countBelow} more</Text>}
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs list view (compact single-line per run)
// ─────────────────────────────────────────────────────────────────────────────

function RunsListView({
  agentName,
  runs,
  onSelect,
  onBack,
  availableHeight,
}: {
  agentName: string;
  runs: EvalRunResult[];
  onSelect: (run: EvalRunResult) => void;
  onBack: () => void;
  availableHeight: number;
}) {
  const nav = useListNavigation({
    items: runs,
    onSelect: item => onSelect(item),
    onExit: onBack,
    isActive: true,
  });

  // Subtract 2 lines for the header (agent name + separator)
  const listHeight = Math.max(4, availableHeight - 2);
  const { visible, showUp, showDown, countAbove, countBelow } = useWindowedList(runs, nav.selectedIndex, listHeight, 1);

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          Eval Runs —{' '}
          <Text bold color="cyan">
            {agentName}
          </Text>
          <Text dimColor>
            {' '}
            {runs.length} run{runs.length !== 1 ? 's' : ''}
          </Text>
        </Text>
        <Text dimColor>{'─'.repeat(60)}</Text>
        {showUp && <Text dimColor> ↑ {countAbove} more</Text>}
        {visible.map((run, vIdx) => {
          const idx = (showUp ? countAbove : 0) + vIdx;
          const selected = idx === nav.selectedIndex;
          const scores = run.results.map(r => ({ name: shortEvalName(r.evaluator), score: r.aggregateScore }));

          return (
            <Text key={run.timestamp} wrap="truncate-end">
              <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
              <Text dimColor>{formatShortDate(run.timestamp).padEnd(16)}</Text>
              <Text dimColor>
                {String(run.sessionCount).padStart(3)} session{run.sessionCount !== 1 ? 's' : ' '}{' '}
              </Text>
              {scores.map((s, i) => (
                <Text key={i}>
                  {i > 0 && <Text dimColor>, </Text>}
                  <Text>{s.name} </Text>
                  <Text color={scoreColor(s.score)}>{formatScore(s.score)}</Text>
                </Text>
              ))}
            </Text>
          );
        })}
        {showDown && <Text dimColor> ↓ {countBelow} more</Text>}
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Run detail view
// ─────────────────────────────────────────────────────────────────────────────

function EvaluatorDetail({ result }: { result: EvalEvaluatorResult }) {
  const errCount = result.sessionScores.filter(s => s.errorMessage).length;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text bold>{shortEvalName(result.evaluator)}</Text>
        {'  '}
        <Text color={scoreColor(result.aggregateScore)}>Score: {formatScore(result.aggregateScore)}</Text>
        {'  '}
        <Text dimColor>
          ({result.sessionScores.length} session{result.sessionScores.length !== 1 ? 's' : ''}
          {errCount > 0 ? `, ${errCount} errors` : ''})
        </Text>
      </Text>
      {result.tokenUsage && (
        <Text dimColor>
          {'  '}Tokens: {result.tokenUsage.inputTokens.toLocaleString()} in /{' '}
          {result.tokenUsage.outputTokens.toLocaleString()} out
        </Text>
      )}
      {result.sessionScores.map((ss, i) => (
        <Text key={i} dimColor>
          {'  '}
          {ss.sessionId.slice(0, 16)}…{' '}
          {ss.errorMessage ? (
            <Text color="red">ERROR: {ss.errorMessage.slice(0, 60)}</Text>
          ) : (
            <>
              <Text color={scoreColor(ss.value)}>{formatScore(ss.value)}</Text>
              {ss.label && <Text> ({ss.label})</Text>}
            </>
          )}
        </Text>
      ))}
    </Box>
  );
}

function RunDetailView({ run, onBack, maxHeight }: { run: EvalRunResult; onBack: () => void; maxHeight: number }) {
  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onBack();
    }
  });

  return (
    <Box flexDirection="column" height={maxHeight} overflowY="hidden">
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold>Agent:</Text> {run.agent}
          {'  '}
          <Text bold>Date:</Text> {formatFullDate(run.timestamp)}
          {'  '}
          <Text bold>Lookback:</Text> {run.lookbackDays}d
        </Text>
        <Text>
          <Text bold>Sessions:</Text> {run.sessionCount}
          {'  '}
          <Text bold>Evaluators:</Text> {run.evaluators.map(shortEvalName).join(', ')}
        </Text>
      </Box>
      <Text color="gray">{'─'.repeat(60)}</Text>
      {run.results.map((result, i) => (
        <EvaluatorDetail key={i} result={result} />
      ))}
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

interface EvalScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type View = 'agents' | 'runs' | 'detail';

interface EvalState {
  phase: 'loading' | 'loaded' | 'error';
  runs: EvalRunResult[];
  error: string | null;
}

export function EvalScreen({ onExit }: EvalScreenProps) {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [state, setState] = useState<EvalState>({
    phase: 'loading',
    runs: [],
    error: null,
  });
  const [view, setView] = useState<View>('agents');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<EvalRunResult | null>(null);
  const [resultsDir, setResultsDir] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        setResultsDir(getResultsPath());
      } catch {
        // ignore — no project context
      }
      const result = handleListEvalRuns({});
      if (!result.success) {
        setState({ phase: 'error', runs: [], error: result.error?.message ?? 'Unknown error' });
        return;
      }
      setState({ phase: 'loaded', runs: result.runs ?? [], error: null });
    };
    void load();
  }, []);

  // Group runs by agent
  const agentGroups: AgentGroup[] = useMemo(() => {
    const map = new Map<string, { runs: EvalRunResult[] }>();
    for (const run of state.runs) {
      const entry = map.get(run.agent);
      if (entry) {
        entry.runs.push(run);
      } else {
        map.set(run.agent, { runs: [run] });
      }
    }

    return Array.from(map.entries())
      .map(([agent, { runs }]) => ({
        agent,
        runCount: runs.length,
        lastRun: runs[0]!.timestamp,
      }))
      .sort((a, b) => new Date(b.lastRun).getTime() - new Date(a.lastRun).getTime());
  }, [state.runs]);

  // Runs for selected agent
  const agentRuns = useMemo(
    () => (selectedAgent ? state.runs.filter(r => r.agent === selectedAgent) : []),
    [state.runs, selectedAgent]
  );

  // If only one agent, skip the picker (state sync pattern — no effect needed)
  if (state.phase === 'loaded' && agentGroups.length === 1 && view === 'agents') {
    setSelectedAgent(agentGroups[0]!.agent);
    setView('runs');
  }

  const helpText =
    view === 'detail'
      ? 'Esc/B back to runs'
      : view === 'runs' && agentGroups.length > 1
        ? 'Esc back to agents'
        : state.runs.length > 0
          ? HELP_TEXT.NAVIGATE_SELECT
          : HELP_TEXT.EXIT;

  const screenTitle = view === 'runs' || view === 'detail' ? 'Eval Runs' : 'Eval Runs';

  const noRuns = state.phase === 'loaded' && state.runs.length === 0;
  const exitEnabled = noRuns || (view === 'agents' && agentGroups.length > 1);

  return (
    <Screen title={screenTitle} onExit={onExit} helpText={helpText} exitEnabled={exitEnabled}>
      {state.phase === 'loading' && <Text dimColor>Loading eval runs...</Text>}

      {state.phase === 'error' && <Text color={STATUS_COLORS.error}>{state.error}</Text>}

      {noRuns && (
        <Box flexDirection="column">
          <Text dimColor>No eval runs found.</Text>
          <Text dimColor>Run `agentcore run eval` to evaluate a project agent,</Text>
          <Text dimColor>
            or `agentcore run eval --agent-arn <Text bold>ARN</Text> --evaluator-arn <Text bold>ARN</Text>` for agents
            outside the project.
          </Text>
          {resultsDir && <Text dimColor>Results saved to: {resultsDir}</Text>}
        </Box>
      )}

      {state.phase === 'loaded' && view === 'agents' && agentGroups.length > 1 && (
        <AgentPickerView
          groups={agentGroups}
          onSelect={agent => {
            setSelectedAgent(agent);
            setView('runs');
          }}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}

      {state.phase === 'loaded' && view === 'runs' && selectedAgent && (
        <RunsListView
          agentName={selectedAgent}
          runs={agentRuns}
          onSelect={run => {
            setSelectedRun(run);
            setView('detail');
          }}
          onBack={() => {
            if (agentGroups.length > 1) {
              setView('agents');
              setSelectedAgent(null);
            } else {
              onExit();
            }
          }}
          availableHeight={availableHeight}
        />
      )}

      {state.phase === 'loaded' && view === 'detail' && selectedRun && (
        <Panel fullWidth>
          <RunDetailView run={selectedRun} onBack={() => setView('runs')} maxHeight={availableHeight} />
        </Panel>
      )}
    </Screen>
  );
}
