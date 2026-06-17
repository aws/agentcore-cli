import { GatewayNameSchema, KnowledgeBaseNameSchema, S3DataSourceSchema } from '../../../../schema';
import { type DataSourceTypeFlag, flagToWireType } from '../../../operations/knowledge-base/connector-config';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import { INLINE_JSON_PREFIX } from './inline-connector-config';
import type { AddKnowledgeBaseConfig, CapturedDataSource } from './types';
import React, { useMemo, useState } from 'react';
import { z } from 'zod';

// Canonical step list. The 'new-gateway-name' state is intentionally a
// sub-step of 'gateway' (mirrors the kb-id sub-step pattern in
// useAddGatewayTargetWizard) and is not in this list — it maps onto 'gateway'
// for the StepIndicator/index lookup.
type Step = 'name' | 'description' | 'data-source-type' | 'sources' | 'add-another' | 'gateway' | 'confirm';
// 'remove-source' is a sub-step of 'add-another' — it shows a picker of
// captured sources so the user can drop one before continuing. Mapped onto
// 'add-another' for the StepIndicator. Same pattern as 'new-gateway-name'.
type WizardState = Step | 'new-gateway-name' | 'remove-source';

const STEP_LABELS: Record<Step, string> = {
  name: 'Name',
  description: 'Description',
  'data-source-type': 'Source Type',
  sources: 'Sources',
  'add-another': 'Add another?',
  gateway: 'Gateway',
  confirm: 'Confirm',
};

const STEPS: Step[] = ['name', 'description', 'data-source-type', 'sources', 'add-another', 'gateway', 'confirm'];

// Each source carries its own type, so a single wizard run can mix S3 with one
// or more connector types. The Flow groups by `dataSourceType` and dispatches
// one primitive.add() call per group: the first creates the KB, subsequent
// groups append to it.
const DATA_SOURCE_TYPE_OPTIONS: SelectableItem[] = [
  { id: 's3', title: 'Amazon S3 — documents in an S3 bucket' },
  { id: 'web-crawler', title: 'Web Crawler — crawl and index web pages' },
  { id: 'confluence', title: 'Confluence — Atlassian Confluence wiki' },
  { id: 'sharepoint', title: 'SharePoint — Microsoft SharePoint documents' },
  { id: 'onedrive', title: 'OneDrive — Microsoft OneDrive files' },
  { id: 'google-drive', title: 'Google Drive — Google Drive files' },
];

// Friendly label for each data-source-type id, used in the confirm view.
const DATA_SOURCE_TYPE_LABELS: Record<string, string> = {
  s3: 'S3',
  'web-crawler': 'Web Crawler',
  confluence: 'Confluence',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  'google-drive': 'Google Drive',
};

const ADD_ANOTHER_OPTIONS: SelectableItem[] = [
  { id: 'add-another', title: 'Add another data source' },
  { id: 'done', title: 'Done — review and submit' },
];

// Same shape, augmented with a "Remove a captured source" option that we
// surface only when the user already has a source they could drop.
const ADD_ANOTHER_OPTIONS_WITH_REMOVE: SelectableItem[] = [
  { id: 'add-another', title: 'Add another data source' },
  { id: 'remove-source', title: 'Remove a captured data source' },
  { id: 'done', title: 'Done — review and submit' },
];

// Connector-config inputs accept EITHER a file path OR the JSON contents
// pasted in directly. Most terminals collapse a pasted multi-line JSON into a
// single line of text — that's fine, JSON.parse doesn't care about newlines.
//
// We classify by the first non-whitespace character: `{` means inline JSON,
// anything else means a file path. Inline JSON is parsed inline so the user
// gets immediate feedback if it's malformed or its `type` field doesn't match
// the connector kind they picked at the data-source-type step. The Flow
// materializes accepted inline JSON to a file under app/<kbName>/ before
// dispatching to the primitive.
//
// Path inputs only get a non-empty check here; the file's actual contents are
// validated in the primitive's add() (file exists, JSON parses, type matches).
function makeConnectorConfigSchema(pendingType: string) {
  const declaredWireType = flagToWireType(pendingType);
  return z
    .string()
    .min(1, 'Enter a connector config file path or paste the JSON contents')
    .superRefine((s, ctx) => {
      const trimmed = s.trimStart();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        // Treat as a file path; primitive validates the rest.
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Looks like JSON but failed to parse. Check brackets and quoting.',
        });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Connector config must be a JSON object (e.g. { "type": "WEB", ... }).',
        });
        return;
      }
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.type !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Connector config is missing a string "type" field.',
        });
        return;
      }
      if (obj.type !== declaredWireType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Connector config "type" is "${obj.type}" but you picked ${pendingType} (expects "${declaredWireType}").`,
        });
      }
    });
}

const SKIP_GATEWAY_ID = '__skip__';
const CREATE_NEW_GATEWAY_ID = '__create_new__';

// Extract just the URI piece of S3DataSourceSchema for inline validation in
// the TextInput component.
const S3UriSchema = z
  .string()
  .min(1)
  .refine(uri => S3DataSourceSchema.safeParse({ type: 'S3', uri }).success, {
    message: 'Must be a valid s3://bucket[/prefix] URI',
  });

interface AddKnowledgeBaseScreenProps {
  onComplete: (config: AddKnowledgeBaseConfig) => void;
  onExit: () => void;
  existingKnowledgeBaseNames: string[];
  existingGatewayNames: string[];
}

export function AddKnowledgeBaseScreen({
  onComplete,
  onExit,
  existingKnowledgeBaseNames,
  existingGatewayNames,
}: AddKnowledgeBaseScreenProps) {
  const [step, setStep] = useState<WizardState>('name');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // The type currently being entered at the 'sources' step. Updated every
  // time the user passes through 'data-source-type' (including the loop from
  // 'add-another -> yes'), so each captured source is tagged with the type
  // active at the moment it was entered.
  const [pendingType, setPendingType] = useState<DataSourceTypeFlag>('s3');
  const [dataSources, setDataSources] = useState<CapturedDataSource[]>([]);
  const [gateway, setGateway] = useState<string | undefined>(undefined);
  // When the user chose "Create a new gateway and attach", this holds the
  // typed name. The KB Flow consumes this and creates the gateway first
  // before adding the KB. Mutually exclusive with `gateway`.
  const [newGatewayName, setNewGatewayName] = useState<string | undefined>(undefined);

  const isPendingS3 = pendingType === 's3';

  const isNameStep = step === 'name';
  const isDescriptionStep = step === 'description';
  const isDataSourceTypeStep = step === 'data-source-type';
  const isSourcesStep = step === 'sources';
  const isAddAnotherStep = step === 'add-another';
  const isRemoveSourceStep = step === 'remove-source';
  const isGatewayStep = step === 'gateway';
  const isNewGatewayNameStep = step === 'new-gateway-name';
  const isConfirmStep = step === 'confirm';

  const hasGateways = existingGatewayNames.length > 0;

  // Number of sources already captured for the *current* pendingType run, used
  // to label inputs ("S3 URI #2") and decide where Esc returns to.
  const sourcesForPendingType = useMemo(
    () => dataSources.filter(ds => ds.dataSourceType === pendingType).length,
    [dataSources, pendingType]
  );

  // Gateway-step picker contents adapt to whether any gateways exist:
  //   - Zero gateways: ["Create a new gateway and attach", "Skip — KB will be standalone"].
  //   - One or more gateways: existing names + "Skip" sentinel + "Create a new gateway and attach"
  //     appended at the end.
  const gatewayItems: SelectableItem[] = useMemo(() => {
    if (!hasGateways) {
      return [
        { id: CREATE_NEW_GATEWAY_ID, title: 'Create a new gateway and attach' },
        { id: SKIP_GATEWAY_ID, title: 'Skip — KB will be standalone (you can attach later)' },
      ];
    }
    return [
      ...existingGatewayNames.map(g => ({ id: g, title: g })),
      { id: SKIP_GATEWAY_ID, title: 'Skip — don’t wire to a gateway' },
      { id: CREATE_NEW_GATEWAY_ID, title: 'Create a new gateway and attach' },
    ];
  }, [existingGatewayNames, hasGateways]);

  const dataSourceTypeNav = useListNavigation({
    items: DATA_SOURCE_TYPE_OPTIONS,
    isActive: isDataSourceTypeStep,
    onSelect: (item: SelectableItem) => {
      setPendingType(item.id as DataSourceTypeFlag);
      setStep('sources');
    },
    // Esc from the type picker: if we already have at least one captured
    // source, the only sensible return is the add-another decision (we can't
    // un-capture earlier sources). Otherwise go back to description.
    onExit: () => setStep(dataSources.length === 0 ? 'description' : 'add-another'),
  });

  // Surface the "Remove a captured source" option only when there's something
  // to remove. Avoids showing a dead-end action when the user has just one
  // source and would have to cancel the wizard if they picked it (you can't
  // submit a KB with zero sources).
  const addAnotherItems = dataSources.length > 1 ? ADD_ANOTHER_OPTIONS_WITH_REMOVE : ADD_ANOTHER_OPTIONS;
  const addAnotherNav = useListNavigation({
    items: addAnotherItems,
    isActive: isAddAnotherStep,
    onSelect: (item: SelectableItem) => {
      if (item.id === 'add-another') {
        // FIX: route back through the data-source-type picker so the user can
        // pick a different type (or the same one) for the next source.
        setStep('data-source-type');
      } else if (item.id === 'remove-source') {
        setStep('remove-source');
      } else {
        setStep('gateway');
      }
    },
    onExit: () => setStep('data-source-type'),
  });

  // Captured-source picker (sub-step of 'add-another'). Each item shows the
  // type and the value (or an inline-JSON marker), keyed by capture index so
  // duplicates pick different rows.
  const removableSourceItems = useMemo<SelectableItem[]>(
    () =>
      dataSources.map((ds, idx) => {
        const label = DATA_SOURCE_TYPE_LABELS[ds.dataSourceType] ?? ds.dataSourceType;
        const display = ds.value.startsWith(INLINE_JSON_PREFIX) ? '<inline JSON>' : ds.value;
        return { id: String(idx), title: `${label}: ${display}` };
      }),
    [dataSources]
  );

  const removeSourceNav = useListNavigation({
    items: removableSourceItems,
    isActive: isRemoveSourceStep,
    onSelect: (item: SelectableItem) => {
      const idx = Number(item.id);
      const next = dataSources.filter((_, i) => i !== idx);
      setDataSources(next);
      // Stay on add-another if there's still anything left, otherwise drop
      // straight back to data-source-type so the user can capture again.
      setStep(next.length > 0 ? 'add-another' : 'data-source-type');
    },
    onExit: () => setStep('add-another'),
  });

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    isActive: isGatewayStep,
    onSelect: (item: SelectableItem) => {
      if (item.id === CREATE_NEW_GATEWAY_ID) {
        // Sub-step: prompt for a new gateway name. Don't create it yet — the
        // Flow does the create + KB add as a single submit so the user only
        // sees the gateway materialise after confirming.
        setGateway(undefined);
        setStep('new-gateway-name');
        return;
      }
      setNewGatewayName(undefined);
      setGateway(item.id === SKIP_GATEWAY_ID ? undefined : item.id);
      setStep('confirm');
    },
    onExit: () => setStep('add-another'),
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () =>
      onComplete({
        name,
        dataSources,
        description: description || undefined,
        gateway,
        newGatewayName,
      }),
    onExit: () => setStep('gateway'),
    isActive: isConfirmStep,
  });

  const helpText =
    isDataSourceTypeStep || isAddAnotherStep || isGatewayStep || isRemoveSourceStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  // The new-gateway-name and remove-source sub-steps map onto their parents
  // for the StepIndicator, mirroring the kb-id sub-step pattern in
  // useAddGatewayTargetWizard.
  const indicatorStep: Step = isNewGatewayNameStep ? 'gateway' : isRemoveSourceStep ? 'add-another' : step;
  const headerContent = <StepIndicator steps={STEPS} currentStep={indicatorStep} labels={STEP_LABELS} />;

  // Confirm view: render every captured source on its own line, prefixed by
  // its type label (e.g. "S3:           s3://bucket/docs/"). Lines stay in
  // capture order so the user sees exactly what they entered.
  const dataSourcesSummary = useMemo(() => {
    if (dataSources.length === 0) return '(none)';
    const labelWidth =
      Math.max(...dataSources.map(ds => (DATA_SOURCE_TYPE_LABELS[ds.dataSourceType] ?? ds.dataSourceType).length)) + 1;
    return dataSources
      .map(ds => {
        const label = `${DATA_SOURCE_TYPE_LABELS[ds.dataSourceType] ?? ds.dataSourceType}:`.padEnd(labelWidth + 1);
        // Inline-JSON entries carry the full payload as their `value`; render
        // a short summary instead of dumping the JSON into the confirm card.
        const display = ds.value.startsWith(INLINE_JSON_PREFIX)
          ? `<inline JSON, will save under app/${name || '<kb>'}/>`
          : ds.value;
        return `${label} ${display}`;
      })
      .join('\n');
  }, [dataSources, name]);

  const gatewayConfirmValue = useMemo(() => {
    if (newGatewayName) return `${newGatewayName} (will be created)`;
    if (gateway) return `${gateway} (existing)`;
    return 'none — KB will be standalone';
  }, [gateway, newGatewayName]);

  const confirmFields = useMemo(
    () => [
      { label: 'Name', value: name },
      ...(description ? [{ label: 'Description', value: description }] : []),
      { label: `Data Sources (${dataSources.length})`, value: dataSourcesSummary },
      { label: 'Gateway', value: gatewayConfirmValue },
    ],
    [name, description, dataSources.length, dataSourcesSummary, gatewayConfirmValue]
  );

  return (
    <Screen
      title="Add Knowledge Base"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={isNameStep}
    >
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Knowledge base name"
            initialValue={generateUniqueName('MyKnowledgeBase', existingKnowledgeBaseNames)}
            onSubmit={(value: string) => {
              setName(value);
              setStep('description');
            }}
            onCancel={onExit}
            schema={KnowledgeBaseNameSchema}
            customValidation={value =>
              !existingKnowledgeBaseNames.includes(value) || 'Knowledge base name already exists'
            }
          />
        )}

        {isDescriptionStep && (
          <TextInput
            key="description"
            prompt="Description (optional, press Enter to skip)"
            onSubmit={(value: string) => {
              setDescription(value);
              setStep('data-source-type');
            }}
            onCancel={() => setStep('name')}
            allowEmpty
          />
        )}

        {isDataSourceTypeStep && (
          <WizardSelect
            title="Data source type"
            description={
              dataSources.length === 0
                ? 'Pick the type of the first data source. You can mix types in this run.'
                : `Pick the type for the next data source (${dataSources.length} already captured).`
            }
            items={DATA_SOURCE_TYPE_OPTIONS}
            selectedIndex={dataSourceTypeNav.selectedIndex}
          />
        )}

        {isSourcesStep && isPendingS3 && (
          <TextInput
            key={`source-s3-${dataSources.length}`}
            prompt={
              sourcesForPendingType === 0
                ? 'S3 URI for data source (e.g. s3://my-bucket/docs/)'
                : `S3 URI #${sourcesForPendingType + 1}`
            }
            onSubmit={(value: string) => {
              setDataSources([...dataSources, { dataSourceType: pendingType, value }]);
              setStep('add-another');
            }}
            onCancel={() => setStep(dataSources.length === 0 ? 'data-source-type' : 'add-another')}
            schema={S3UriSchema}
          />
        )}

        {isSourcesStep && !isPendingS3 && (
          <TextInput
            key={`source-${pendingType}-${dataSources.length}`}
            prompt={
              sourcesForPendingType === 0
                ? `Connector config for ${pendingType} — paste JSON or enter a file path`
                : `Connector config #${sourcesForPendingType + 1}`
            }
            description="Paste the JSON contents (starts with {) or enter a path like ./web.json. Templates: docs/connector-config-templates/."
            onSubmit={(value: string) => {
              const trimmed = value.trimStart();
              const isInlineJson = trimmed.startsWith('{') || trimmed.startsWith('[');
              setDataSources([
                ...dataSources,
                {
                  dataSourceType: pendingType,
                  // Tag inline JSON with a sentinel prefix; the Flow writes it
                  // to disk before dispatching to the primitive. Plain paths
                  // pass through unchanged (the primitive does its own copy).
                  value: isInlineJson ? `${INLINE_JSON_PREFIX}${trimmed}` : value,
                },
              ]);
              setStep('add-another');
            }}
            onCancel={() => setStep(dataSources.length === 0 ? 'data-source-type' : 'add-another')}
            schema={makeConnectorConfigSchema(pendingType)}
          />
        )}

        {isAddAnotherStep && (
          <WizardSelect
            title="Add another data source?"
            description={`Currently captured: ${dataSources.length} source(s) across ${
              new Set(dataSources.map(ds => ds.dataSourceType)).size
            } type(s)`}
            items={addAnotherItems}
            selectedIndex={addAnotherNav.selectedIndex}
          />
        )}

        {isRemoveSourceStep && (
          <WizardSelect
            title="Remove a captured data source"
            description="Pick a source to drop. Press Esc to keep all and go back."
            items={removableSourceItems}
            selectedIndex={removeSourceNav.selectedIndex}
          />
        )}

        {isGatewayStep && (
          <WizardSelect
            title="Wire this knowledge base to a gateway?"
            description={
              hasGateways
                ? 'A connector target will be created on the selected gateway, exposing this KB as an MCP retrieval tool.'
                : 'No gateways exist in this project yet. Create one inline, or skip and attach later.'
            }
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {isNewGatewayNameStep && (
          <TextInput
            key="new-gateway-name"
            prompt="New gateway name"
            description="The gateway will be created when you submit this wizard, then the KB will be wired to it."
            initialValue={`${name}-gw`}
            onSubmit={(value: string) => {
              setNewGatewayName(value);
              setGateway(undefined);
              setStep('confirm');
            }}
            onCancel={() => setStep('gateway')}
            schema={GatewayNameSchema}
            customValidation={value =>
              !existingGatewayNames.includes(value) || 'Gateway name already exists in this project'
            }
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
