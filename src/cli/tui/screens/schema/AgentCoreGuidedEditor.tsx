import {
  AgentCoreProjectSpecSchema,
  BuildTypeSchema,
  ModelProviderSchema,
  NetworkModeSchema,
  PythonRuntimeSchema,
  SDKFrameworkSchema,
  TargetLanguageSchema,
} from '../../../../schema';
import type { AgentCoreProjectSpec, PathType } from '../../../../schema';
import { Cursor, Header, Panel, PathInput, ScreenLayout, SelectList } from '../../components';
import { useResponsive } from '../../hooks/useResponsive';
import { useSchemaDocument } from '../../hooks/useSchemaDocument';
import { diffLines } from '../../utils';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

interface SchemaOption {
  id: string;
  title: string;
  description: string;
  filePath: string;
}

type FieldType = 'string' | 'number' | 'enum' | 'bool' | 'object' | 'list';

type PathSegment = string | number;

interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  path: PathSegment[];
  enumValues?: readonly string[];
  readOnly?: boolean;
  /** When set, renders a PathInput with file or directory completion */
  pathType?: PathType;
}

interface TabDef {
  id: string;
  title: string;
  fields: FieldDef[];
}

interface EditorStatus {
  tone: 'success' | 'error' | 'info';
  text: string;
}

type FieldErrorMap = Record<string, string>;

interface IssueEntry {
  id: string;
  path: PathSegment[];
  message: string;
  tabId?: TabId;
  fieldIndex?: number;
  fieldLabel?: string;
}

const TAB_ORDER = ['general', 'model', 'runtime'] as const;

type TabId = (typeof TAB_ORDER)[number];

function getStatusMessageColor(tone: 'success' | 'error' | 'info'): 'red' | 'green' | 'white' {
  switch (tone) {
    case 'error':
      return 'red';
    case 'success':
      return 'green';
    case 'info':
      return 'white';
  }
}

export function AgentCoreGuidedEditor(props: { schema: SchemaOption; onBack: () => void }) {
  const { content, status, validationMessage, save } = useSchemaDocument(
    props.schema.filePath,
    AgentCoreProjectSpecSchema
  );

  if (status.status === 'loading') {
    return (
      <ScreenLayout onExit={props.onBack}>
        <Header title="Edit Schema" subtitle={`Loading ${props.schema.title}...`} />
        <Box marginTop={1}>
          <Text dimColor>Loading schema from disk.</Text>
        </Box>
      </ScreenLayout>
    );
  }

  if (status.status === 'error') {
    return (
      <ScreenLayout onExit={props.onBack}>
        <Header title="Edit Schema" subtitle={props.schema.title} />
        <Box marginTop={1} flexDirection="column">
          <Text color="red">Unable to load schema.</Text>
          <Text dimColor>{status.message ?? 'Unknown error'}</Text>
          <Text dimColor>Esc back</Text>
        </Box>
      </ScreenLayout>
    );
  }

  let parsed: AgentCoreProjectSpec | null = null;
  let parseError: string | null = null;
  let validationErrors: { path: string; message: string }[] = [];

  try {
    const raw = JSON.parse(content) as unknown;
    const result = AgentCoreProjectSpecSchema.safeParse(raw);
    if (result.success) {
      parsed = result.data;
    } else {
      // Capture Zod validation errors with path and message
      validationErrors = result.error.issues.map(issue => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      }));
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : 'Invalid JSON';
  }

  if (parseError || validationErrors.length > 0) {
    return (
      <ScreenLayout onExit={props.onBack}>
        <Header title="Edit Schema" subtitle={props.schema.title} />
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>
            Schema has validation errors
          </Text>
          <Text dimColor>Fix the errors below, then try again.</Text>
          <Box marginTop={1} flexDirection="column">
            {parseError && (
              <Box>
                <Text color="red">• JSON parse error: </Text>
                <Text>{parseError}</Text>
              </Box>
            )}
            {validationErrors.map((err, idx) => (
              <Box key={idx} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color="yellow">• </Text>
                  <Text color="cyan">{err.path}</Text>
                </Box>
                <Box marginLeft={2}>
                  <Text color="red">{err.message}</Text>
                </Box>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Esc back</Text>
          </Box>
        </Box>
      </ScreenLayout>
    );
  }

  if (!parsed) {
    return (
      <ScreenLayout onExit={props.onBack}>
        <Header title="Edit Schema" subtitle={props.schema.title} />
        <Box marginTop={1} flexDirection="column">
          <Text color="red">Unable to parse schema.</Text>
          <Text dimColor>Esc back</Text>
        </Box>
      </ScreenLayout>
    );
  }

  return (
    <AgentCoreGuidedEditorBody
      key={content}
      schema={props.schema}
      initialDraft={parsed}
      baseline={JSON.stringify(parsed, null, 2)}
      validationMessage={validationMessage}
      onBack={props.onBack}
      onSave={save}
    />
  );
}

function AgentCoreGuidedEditorBody(props: {
  schema: SchemaOption;
  initialDraft: AgentCoreProjectSpec;
  baseline: string;
  validationMessage?: string;
  onBack: () => void;
  onSave: (nextContent: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { stdout } = useStdout();
  const { height: _terminalHeight } = useResponsive();
  const [terminalRows, setTerminalRows] = useState(stdout?.rows ?? 24);

  const [draft, setDraft] = useState<AgentCoreProjectSpec>(props.initialDraft);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingField, setEditingField] = useState<FieldDef | null>(null);
  const [inlineEditValue, setInlineEditValue] = useState<string | null>(null); // null = not inline editing
  const [inlineEnumIndex, setInlineEnumIndex] = useState<number | null>(null); // null = not editing enum
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<EditorStatus | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmSaveMode, setConfirmSaveMode] = useState(false);
  const [diffScroll, setDiffScroll] = useState(0);
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);

  useEffect(() => {
    if (!stdout) return;
    const update = () => setTerminalRows(stdout.rows);
    stdout.on('resize', update);
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);

  // Clamp activeAgentIndex to valid range
  const agentIndex = Math.min(activeAgentIndex, Math.max(0, draft.agents.length - 1));
  const agentCount = draft.agents.length;

  const { tabs, fieldErrors, runtimeArtifact, issues } = useMemo(() => {
    if (!draft || draft.agents.length === 0) {
      return {
        tabs: [] as TabDef[],
        fieldErrors: {} as FieldErrorMap,
        runtimeArtifact: '',
        issues: [] as IssueEntry[],
      };
    }

    const agent = draft.agents[agentIndex];
    if (!agent) {
      return {
        tabs: [] as TabDef[],
        fieldErrors: {} as FieldErrorMap,
        runtimeArtifact: '',
        issues: [] as IssueEntry[],
      };
    }
    const runtimeArtifact = agent.build;

    const tabs: TabDef[] = [
      {
        id: 'general',
        title: 'General',
        fields: [
          { id: 'schema-name', label: 'Schema Name', type: 'string', path: ['name'] },
          { id: 'schema-version', label: 'Schema Version', type: 'string', path: ['version'] },
          { id: 'schema-description', label: 'Description', type: 'string', path: ['description'] },
          { id: 'agent-name', label: 'Agent Name', type: 'string', path: ['agents', agentIndex, 'name'] },
          { id: 'agent-id', label: 'Agent Id', type: 'string', path: ['agents', agentIndex, 'id'] },
        ],
      },
      {
        id: 'model',
        title: 'Model',
        fields: [
          {
            id: 'sdk-framework',
            label: 'SDK Framework',
            type: 'enum',
            path: ['agents', agentIndex, 'sdkFramework'],
            enumValues: SDKFrameworkSchema.options,
          },
          {
            id: 'target-language',
            label: 'Target Language',
            type: 'enum',
            path: ['agents', agentIndex, 'targetLanguage'],
            enumValues: TargetLanguageSchema.options,
          },
          {
            id: 'model-provider',
            label: 'Model Provider',
            type: 'enum',
            path: ['agents', agentIndex, 'modelProvider'],
            enumValues: ModelProviderSchema.options,
          },
        ],
      },
      {
        id: 'runtime',
        title: 'Runtime',
        fields: [
          {
            id: 'runtime-build',
            label: 'Build Type',
            type: 'enum',
            path: ['agents', agentIndex, 'build'],
            enumValues: BuildTypeSchema.options,
          },
          {
            id: 'runtime-entrypoint',
            label: 'Entrypoint',
            type: 'string',
            path: ['agents', agentIndex, 'runtime', 'entrypoint'],
            pathType: 'file',
          },
          {
            id: 'runtime-code-location',
            label: 'Code Location',
            type: 'string',
            path: ['agents', agentIndex, 'runtime', 'codeLocation'],
            pathType: 'directory',
          },
          {
            id: 'runtime-network',
            label: 'Network Mode',
            type: 'enum',
            path: ['agents', agentIndex, 'runtime', 'networkMode'],
            enumValues: NetworkModeSchema.options,
          },
          {
            id: 'runtime-description',
            label: 'Runtime Description',
            type: 'string',
            path: ['agents', agentIndex, 'runtime', 'description'],
          },
          ...(runtimeArtifact === 'CodeZip'
            ? ([
                {
                  id: 'runtime-python-version',
                  label: 'Python Version',
                  type: 'enum' as FieldType,
                  path: ['agents', agentIndex, 'runtime', 'pythonVersion'],
                  enumValues: PythonRuntimeSchema.options,
                },
              ] as FieldDef[])
            : ([
                {
                  id: 'runtime-image-uri',
                  label: 'Image Uri',
                  type: 'string' as FieldType,
                  path: ['agents', agentIndex, 'runtime', 'imageUri'],
                },
              ] as FieldDef[])),
        ],
      },
    ];

    const validation = AgentCoreProjectSpecSchema.safeParse(draft);
    const fieldErrors: FieldErrorMap = {};
    const issues: IssueEntry[] = [];
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        const key = issue.path.join('.');
        fieldErrors[key] = issue.message;
        issues.push({
          id: `${issues.length + 1}`,
          path: issue.path as PathSegment[],
          message: issue.message,
        });
      }
    }

    if (issues.length > 0) {
      const allFields = tabs.flatMap(tab =>
        tab.fields.map((field, index) => ({ field, tabId: tab.id as TabId, index }))
      );
      for (const issue of issues) {
        const match = findFieldForIssue(allFields, issue.path);
        if (match) {
          issue.tabId = match.tabId;
          issue.fieldIndex = match.index;
          issue.fieldLabel = match.field.label;
        }
      }
    }

    return { tabs, fieldErrors, runtimeArtifact, issues };
  }, [draft, agentIndex]);

  const activeTabDef = tabs.find(tab => tab.id === activeTab) ?? tabs[0];
  const fields = activeTabDef?.fields ?? [];

  useInput((input, key) => {
    // Confirm save mode: show diff, Y to commit, N/Esc to discard
    if (confirmSaveMode) {
      if (input.toLowerCase() === 'y') {
        // Commit changes
        void (async () => {
          const nextContent = JSON.stringify(draft, null, 2);
          const result = await props.onSave(nextContent);
          if (!result.ok) {
            setStatusMessage({ tone: 'error', text: result.error ?? 'Failed to save' });
            setConfirmSaveMode(false);
            setDiffScroll(0);
          } else {
            props.onBack();
          }
        })();
        return;
      }
      if (input.toLowerCase() === 'n' || key.escape) {
        // Discard and exit
        props.onBack();
        return;
      }
      if (key.upArrow) {
        setDiffScroll(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setDiffScroll(prev => prev + 1);
        return;
      }
      return;
    }

    // Handle inline editing mode
    if (inlineEditValue !== null && editingField) {
      if (key.escape) {
        setInlineEditValue(null);
        setEditingField(null);
        return;
      }
      if (key.return) {
        // Commit the inline edit
        const nextValue = editingField.type === 'number' ? Number(inlineEditValue) : inlineEditValue;
        if (editingField.type === 'number' && Number.isNaN(nextValue)) {
          setStatusMessage({ tone: 'error', text: 'Enter a valid number.' });
        } else {
          const next = setValue(draft, editingField.path, nextValue);
          setDraft(next);
          setDirty(true);
        }
        setInlineEditValue(null);
        setEditingField(null);
        return;
      }
      if (key.backspace || key.delete) {
        setInlineEditValue(v => (v ?? '').slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInlineEditValue(v => (v ?? '') + input);
        return;
      }
      return;
    }

    // Handle inline enum editing mode
    if (inlineEnumIndex !== null && editingField?.enumValues) {
      if (key.escape) {
        setInlineEnumIndex(null);
        setEditingField(null);
        return;
      }
      if (key.upArrow) {
        setInlineEnumIndex(idx => {
          const len = editingField.enumValues!.length;
          return ((idx ?? 0) - 1 + len) % len;
        });
        return;
      }
      if (key.downArrow) {
        setInlineEnumIndex(idx => {
          const len = editingField.enumValues!.length;
          return ((idx ?? 0) + 1) % len;
        });
        return;
      }
      if (key.return) {
        // Commit the enum selection
        const selectedValue = editingField.enumValues[inlineEnumIndex];
        if (selectedValue) {
          const next = setValue(draft, editingField.path, selectedValue);
          setDraft(next);
          setDirty(true);
        }
        setInlineEnumIndex(null);
        setEditingField(null);
        return;
      }
      return;
    }

    if (editingField || errorsOpen) return;
    if (!draft || draft.agents.length === 0 || !draft.agents[agentIndex]) return;

    if (key.escape) {
      if (dirty) {
        setConfirmSaveMode(true);
        setDiffScroll(0);
        return;
      }
      props.onBack();
      return;
    }

    // Cycle through agents (if multiple)
    if (input.toLowerCase() === 'n' && agentCount > 1) {
      setActiveAgentIndex(prev => (prev + 1) % agentCount);
      setSelectedIndex(0);
      return;
    }
    if (input.toLowerCase() === 'p' && agentCount > 1) {
      setActiveAgentIndex(prev => (prev - 1 + agentCount) % agentCount);
      setSelectedIndex(0);
      return;
    }

    // Tab cycles through agents (if multiple)
    if (key.tab && agentCount > 1) {
      setActiveAgentIndex(prev => (prev + 1) % agentCount);
      setSelectedIndex(0);
      return;
    }

    if (key.leftArrow) {
      const currentIdx = TAB_ORDER.indexOf(activeTab);
      const nextIdx = (currentIdx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
      const nextTab = TAB_ORDER[nextIdx];
      if (nextTab) {
        setActiveTab(nextTab);
        setSelectedIndex(0);
      }
      return;
    }

    if (key.rightArrow) {
      const currentIdx = TAB_ORDER.indexOf(activeTab);
      const nextIdx = (currentIdx + 1) % TAB_ORDER.length;
      const nextTab = TAB_ORDER[nextIdx];
      if (nextTab) {
        setActiveTab(nextTab);
        setSelectedIndex(0);
      }
      return;
    }

    if (key.upArrow && fields.length > 0) {
      setSelectedIndex(idx => (idx - 1 + fields.length) % fields.length);
      return;
    }

    if (key.downArrow && fields.length > 0) {
      setSelectedIndex(idx => (idx + 1) % fields.length);
      return;
    }

    if (key.return) {
      const field = fields[selectedIndex];
      if (!field || field.readOnly) {
        setStatusMessage({
          tone: 'info',
          text: 'Field is read-only for now. Use the raw editor to update complex lists.',
        });
        return;
      }
      if (field.type === 'bool') {
        const current = Boolean(getValue(draft, field.path));
        const next = setValue(draft, field.path, !current);
        setDraft(next);
        setDirty(true);
        return;
      }
      if (field.type === 'enum' && field.enumValues) {
        // Start inline enum editing
        const currentValue = getStringValue(getValue(draft, field.path));
        const idx = Math.max(
          0,
          field.enumValues.findIndex(value => value === currentValue)
        );
        setEditingField(field);
        setInlineEnumIndex(idx);
        return;
      }
      if (field.type === 'string' || field.type === 'number') {
        if (field.pathType) {
          // Path fields open in full-screen editor (visually heavy)
          setEditingField(field);
        } else {
          // Simple string/number fields use inline editing
          const currentValue = getStringValue(getValue(draft, field.path));
          setEditingField(field);
          setInlineEditValue(currentValue);
        }
        return;
      }
      setStatusMessage({ tone: 'info', text: 'Editing for this field type is not available yet.' });
      return;
    }

    if (input === 'e') {
      if (issues.length > 0) {
        setErrorsOpen(true);
      }
      return;
    }
  });

  // Handle case where no agent exists
  if (!draft || draft.agents.length === 0 || !draft.agents[agentIndex]) {
    return (
      <ScreenLayout onExit={props.onBack}>
        <Header title="Edit Schema" subtitle={props.schema.title} />
        <Box marginTop={1}>
          <Text color="red">No agent found in schema.</Text>
        </Box>
      </ScreenLayout>
    );
  }

  // Full-screen editor only for path fields (visually heavy)
  if (editingField?.pathType && inlineEditValue === null) {
    return (
      <ScreenLayout>
        <Header title={`Edit ${editingField.label}`} subtitle={props.schema.title} />
        <Box flexDirection="column" marginTop={1}>
          <PathInput
            initialValue={getStringValue(getValue(draft, editingField.path))}
            pathType={editingField.pathType}
            onSubmit={value => {
              const next = setValue(draft, editingField.path, value);
              setDraft(next);
              setDirty(true);
              setEditingField(null);
            }}
            onCancel={() => setEditingField(null)}
          />
        </Box>
      </ScreenLayout>
    );
  }

  if (errorsOpen) {
    return (
      <ScreenLayout>
        <ErrorsOverlay
          issues={issues}
          onClose={() => setErrorsOpen(false)}
          onJump={issue => {
            if (!issue.tabId || issue.fieldIndex === undefined) {
              setStatusMessage({ tone: 'info', text: 'Field is not available in guided view.' });
              setErrorsOpen(false);
              return;
            }
            setActiveTab(issue.tabId);
            setSelectedIndex(issue.fieldIndex);
            setErrorsOpen(false);
          }}
        />
      </ScreenLayout>
    );
  }

  const editorHeight = Math.max(6, terminalRows - 8);
  const currentText = JSON.stringify(draft, null, 2);
  const diffOps = diffLines(props.baseline.split('\n'), currentText.split('\n'));
  // Filter to only show changed lines for the confirm view
  const changedLines = diffOps.filter(line => line.color);

  // Confirm save mode: show diff with Enter to confirm
  if (confirmSaveMode) {
    const visibleLines = terminalRows - 6;
    const maxScroll = Math.max(0, changedLines.length - visibleLines);
    const clampedScroll = Math.min(diffScroll, maxScroll);
    const displayLines = changedLines.slice(clampedScroll, clampedScroll + visibleLines);
    const showScrollUp = clampedScroll > 0;
    const showScrollDown = clampedScroll < maxScroll;

    return (
      <ScreenLayout>
        <Header title="Unsaved Changes" subtitle={props.schema.title} />
        <Box flexDirection="column" gap={1}>
          <Text>You have unsaved changes. What would you like to do?</Text>
          <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            {changedLines.length === 0 ? (
              <Text dimColor>No changes to save.</Text>
            ) : (
              <>
                {showScrollUp && <Text dimColor>↑ {clampedScroll} lines above</Text>}
                {displayLines.map((line, idx) => (
                  <Text key={`${line.value}-${idx}`} color={line.color}>
                    {line.prefix} {line.value}
                  </Text>
                ))}
                {showScrollDown && (
                  <Text dimColor>↓ {changedLines.length - clampedScroll - visibleLines} lines below</Text>
                )}
              </>
            )}
          </Box>
          <Box gap={2}>
            <Text color="cyan" bold>
              Y
            </Text>
            <Text>Commit changes</Text>
          </Box>
          <Box gap={2}>
            <Text color="cyan" bold>
              N
            </Text>
            <Text>Discard changes</Text>
          </Box>
          <Text dimColor>↑↓ scroll diff</Text>
        </Box>
      </ScreenLayout>
    );
  }

  const _activeAgent = draft.agents[agentIndex];

  return (
    <ScreenLayout>
      <Header title="Edit Schema" subtitle={props.schema.title} />
      <Box flexDirection="column">
        <Text dimColor>←→ sections · Enter edit{agentCount > 1 ? ' · Tab agents' : ''} · Esc back</Text>
        {agentCount > 1 && (
          <Box flexDirection="row" gap={1}>
            {draft.agents.map((agent, idx) => (
              <Text
                key={agent.name || idx}
                color={idx === agentIndex ? 'cyan' : undefined}
                dimColor={idx !== agentIndex}
                bold={idx === agentIndex}
              >
                [{idx === agentIndex ? '●' : '○'} {agent.name}]
              </Text>
            ))}
          </Box>
        )}
        {issues.length > 0 && (
          <Text color="red">
            {issues.length} validation {issues.length === 1 ? 'issue' : 'issues'} (press E to view)
          </Text>
        )}
        {props.validationMessage && <Text color="yellow">Schema warning: {props.validationMessage}</Text>}
        {statusMessage && <Text color={getStatusMessageColor(statusMessage.tone)}>{statusMessage.text}</Text>}
      </Box>
      <Box marginTop={1}>
        <Panel title="Fields" flexGrow={1} height={editorHeight} fullWidth>
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {tabs.map(tab => (
                <Text key={tab.id} color={tab.id === activeTab ? 'cyan' : undefined}>
                  [{tab.title}]
                </Text>
              ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
              {fields.map((field, idx) => {
                const selected = idx === selectedIndex;
                const value = getValue(draft, field.path);
                const valueLabel = renderValueLabel(field, value);
                const error = fieldErrors[field.path.join('.')];
                const isInlineTextEditing = editingField?.id === field.id && inlineEditValue !== null;
                const isInlineEnumEditing =
                  editingField?.id === field.id && inlineEnumIndex !== null && field.enumValues;

                return (
                  <Box key={field.id} flexDirection="row" gap={1}>
                    <Text color={selected ? 'cyan' : undefined}>{selected ? '>' : ' '}</Text>
                    <Box width={18} flexShrink={0}>
                      <Text bold={selected} color={selected ? 'cyan' : undefined}>
                        {field.label}
                      </Text>
                    </Box>
                    <Box flexShrink={1}>
                      {isInlineTextEditing ? (
                        // Inline text editing mode
                        <>
                          <Text color="cyan">{inlineEditValue}</Text>
                          <Cursor />
                        </>
                      ) : isInlineEnumEditing ? (
                        // Inline enum editing mode with (N/X) indicator
                        <>
                          <Text color="cyan">{field.enumValues![inlineEnumIndex]}</Text>
                          <Text dimColor>
                            {' '}
                            ({inlineEnumIndex + 1}/{field.enumValues!.length}) ↑↓
                          </Text>
                        </>
                      ) : (
                        <Text color={error ? 'red' : undefined} dimColor={!error}>
                          {valueLabel}
                        </Text>
                      )}
                    </Box>
                    {error && !isInlineTextEditing && !isInlineEnumEditing && (
                      <Text color="red" dimColor>
                        {' '}
                        ✗
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Panel>
      </Box>
      <Box marginTop={1} flexDirection="row" gap={2} flexWrap="wrap">
        {dirty && <Text color="yellow">● Changes pending</Text>}
        <Text dimColor>Runtime: {runtimeArtifact}</Text>
      </Box>
    </ScreenLayout>
  );
}

function renderValueLabel(field: FieldDef, value: unknown) {
  if (field.type === 'list') {
    const length = Array.isArray(value) ? value.length : 0;
    return `${length} items`;
  }
  if (field.type === 'object') {
    return value ? 'object' : 'empty';
  }
  if (value === undefined || value === null || value === '') {
    return '(empty)';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '(complex)';
}

function getStringValue(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function getValue(obj: AgentCoreProjectSpec, path: PathSegment[]) {
  let cursor: unknown = obj;
  for (const segment of path) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof segment === 'number' && Array.isArray(cursor)) {
      cursor = cursor[segment];
    } else if (typeof segment === 'string' && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function findFieldForIssue(fields: { field: FieldDef; tabId: TabId; index: number }[], issuePath: PathSegment[]) {
  const issueKey = issuePath.join('.');
  let bestMatch: { field: FieldDef; tabId: TabId; index: number } | null = null;
  let bestScore = -1;

  for (const candidate of fields) {
    const fieldKey = candidate.field.path.join('.');
    if (issueKey === fieldKey) return candidate;
    if (issueKey.startsWith(`${fieldKey}.`)) {
      if (fieldKey.length > bestScore) {
        bestMatch = candidate;
        bestScore = fieldKey.length;
      }
    }
  }

  return bestMatch;
}

function ErrorsOverlay(props: { issues: IssueEntry[]; onClose: () => void; onJump: (issue: IssueEntry) => void }) {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      props.onClose();
      return;
    }
    if (key.upArrow) {
      setIndex(prev => (prev - 1 + props.issues.length) % props.issues.length);
      return;
    }
    if (key.downArrow) {
      setIndex(prev => (prev + 1) % props.issues.length);
      return;
    }
    if (key.return) {
      const issue = props.issues[index];
      if (issue) props.onJump(issue);
    }
  });

  return (
    <Panel title="Validation Issues" borderColor="red">
      <SelectList
        items={props.issues.map((issue, idx) => ({
          id: `${issue.id}-${idx}`,
          title: issue.fieldLabel ? `${issue.fieldLabel} (${issue.path.join('.')})` : issue.path.join('.'),
          description: issue.message,
        }))}
        selectedIndex={index}
        emptyMessage="No validation issues"
      />
      <Text dimColor>↑↓ navigate · Enter jump · Esc close</Text>
    </Panel>
  );
}

function setValue(obj: AgentCoreProjectSpec, path: PathSegment[], value: unknown): AgentCoreProjectSpec {
  const clone = structuredClone(obj);
  let cursor: unknown = clone;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (typeof segment === 'number' && Array.isArray(cursor)) {
      cursor = cursor[segment];
    } else if (typeof segment === 'string' && typeof cursor === 'object' && cursor !== null) {
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  const last = path[path.length - 1];
  if (typeof last === 'number' && Array.isArray(cursor)) {
    cursor[last] = value;
  } else if (typeof last === 'string' && typeof cursor === 'object' && cursor !== null) {
    (cursor as Record<string, unknown>)[last] = value;
  }
  return clone;
}
