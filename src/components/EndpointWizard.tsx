import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useQuery } from "@tanstack/react-query";
import type {
  CreateHarnessEndpointRequest,
  UpdateHarnessEndpointRequest,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { ScreenProps } from "../handlers/types";
import { useCoreOpts, useRegionNavigate } from "../handlers/utils";
import { Layout } from "./Layout";
import { FormRadioGroup, type FormRadioOption } from "./FormRadioGroup";
import { FormTextInput } from "./FormTextInput";
import { ErrorPanel } from "./ErrorPanel";
import { Stepper, type Step } from "./ui/stepper";
import { Spinner } from "./ui/spinner";
import { CodeBlock } from "./ui/code-block";
import { darkTheme, glyphs } from "./ui/_core.js";

const theme = darkTheme;

// EndpointFormValues is the flat shape the endpoint wizard collects. version ""
// means "latest" (create mode omits targetVersion).
export interface EndpointFormValues {
  name: string;
  version: string;
}

type WizardPhase =
  | { kind: "form" }
  | { kind: "submitting" }
  | { kind: "success"; endpointName: string; targetVersion?: string; status?: string }
  | { kind: "error"; message: string };

export interface EndpointWizardProps extends ScreenProps {
  mode: "create" | "update";
  breadcrumb: string[];
  harnessId: string;
  // endpointName is the update target (update mode only).
  endpointName?: string;
  // initial seeds the form (update mode: the endpoint's current settings).
  initial?: EndpointFormValues;
  // onDone is called after a successful submit is acknowledged.
  onDone: (endpointName: string) => void;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

// EndpointWizard is the interactive step flow behind `harness endpoint create`
// and `harness endpoint update`: name → target version (picked from the
// harness's actual versions) → review → submit. Update mode skips the name
// step (endpoints cannot be renamed).
export function EndpointWizard({
  ctx,
  core,
  mode,
  breadcrumb,
  harnessId,
  endpointName,
  initial,
  onDone,
}: EndpointWizardProps) {
  const navigate = useRegionNavigate();
  const opts = useCoreOpts(ctx);

  const steps: Step[] = useMemo(() => {
    const all: Step[] = [
      { key: "name", title: "name" },
      { key: "version", title: "version" },
      { key: "review", title: "review" },
    ];
    return mode === "create" ? all : all.filter((step) => step.key !== "name");
  }, [mode]);

  const [initialValues] = useState<EndpointFormValues>(() => initial ?? { name: "", version: "" });
  const [values, setValues] = useState<EndpointFormValues>(initialValues);
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<WizardPhase>({ kind: "form" });

  // The version step chooses among the harness's real versions.
  const versions = useQuery({
    queryKey: ["harness-versions", opts.region, harnessId],
    queryFn: () => core.harness.listHarnessVersions(harnessId, undefined, undefined, opts),
  });

  const stepKey = steps[stepIndex]!.key;
  const next = () => setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  const back = () => {
    // Safe only while every route in passes a picker first; see HarnessWizard.onExit.
    if (stepIndex === 0) navigate(-1);
    else setStepIndex((i) => i - 1);
  };

  const request: CreateHarnessEndpointRequest | UpdateHarnessEndpointRequest = useMemo(() => {
    if (mode === "create") {
      return {
        harnessId,
        endpointName: values.name,
        targetVersion: values.version || undefined,
      };
    }
    const update: UpdateHarnessEndpointRequest = { harnessId, endpointName: endpointName! };
    if (values.version !== initialValues.version && values.version !== "") {
      update.targetVersion = values.version;
    }
    return update;
  }, [mode, values, harnessId, endpointName, initialValues]);

  const submit = async () => {
    setPhase({ kind: "submitting" });
    try {
      const response =
        mode === "create"
          ? await core.harness.createHarnessEndpoint(request as CreateHarnessEndpointRequest, opts)
          : await core.harness.updateHarnessEndpoint(request as UpdateHarnessEndpointRequest, opts);
      setPhase({
        kind: "success",
        endpointName: response.endpoint?.endpointName ?? values.name ?? endpointName ?? "",
        targetVersion: response.endpoint?.targetVersion,
        status: response.endpoint?.status,
      });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const verb = mode === "create" ? "create" : "update";

  return (
    <Layout breadcrumb={breadcrumb} keyHints={hintsFor(stepKey, phase, verb)}>
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Stepper
            steps={steps}
            currentStep={stepKey}
            completedSteps={steps.slice(0, stepIndex).map((step) => step.key)}
          />
        </Box>

        {phase.kind === "form" && stepKey === "name" && (
          <NameStep
            value={values.name}
            onChange={(name) => setValues((v) => ({ ...v, name }))}
            onNext={next}
            onBack={back}
          />
        )}
        {phase.kind === "form" && stepKey === "version" && (
          <VersionStep
            mode={mode}
            value={values.version}
            versions={versions}
            onChange={(version) => setValues((v) => ({ ...v, version }))}
            onNext={next}
            onBack={back}
          />
        )}
        {phase.kind === "form" && stepKey === "review" && (
          <ReviewStep verb={verb} request={request} onSubmit={submit} onBack={back} />
        )}

        {phase.kind === "submitting" && (
          <Spinner label={mode === "create" ? "creating endpoint…" : "updating endpoint…"} />
        )}
        {phase.kind === "success" && (
          <SuccessPanel
            verb={verb}
            endpointName={phase.endpointName}
            targetVersion={phase.targetVersion}
            status={phase.status}
            onContinue={() => onDone(phase.endpointName)}
          />
        )}
        {phase.kind === "error" && (
          <ErrorPanel message={phase.message} onBack={() => setPhase({ kind: "form" })} />
        )}
      </Box>
    </Layout>
  );
}

function hintsFor(
  stepKey: string,
  phase: WizardPhase,
  verb: string,
): { key: string; label: string }[] {
  if (phase.kind === "submitting") return [{ key: "ctrl+c", label: "quit" }];
  if (phase.kind === "success") return [{ key: "enter", label: "continue" }];
  if (phase.kind === "error")
    return [
      { key: "esc", label: "back" },
      { key: "ctrl+c", label: "quit" },
    ];
  const base = [
    { key: "esc", label: "back" },
    { key: "ctrl+c", label: "quit" },
  ];
  if (stepKey === "version") {
    return [{ key: "↑↓", label: "navigate" }, { key: "enter", label: "continue" }, ...base];
  }
  if (stepKey === "review") return [{ key: "enter", label: verb }, ...base];
  return [{ key: "enter", label: "continue" }, ...base];
}

// Question is the one-line prompt under the stepper — the stepper already
// names the step, so the body opens with the question itself.
function Question({ text }: { text: string }) {
  return <Text color={theme.colors.muted}>{text}</Text>;
}

function NameStep({
  value,
  onChange,
  onNext,
  onBack,
}: {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return && NAME_PATTERN.test(value)) onNext();
  });

  return (
    <Box flexDirection="column">
      <FormTextInput
        name="what should this endpoint be called?"
        helpText="letters, numbers, underscores; starts with a letter"
        errorText="must start with a letter; letters, numbers, and underscores only"
        value={value}
        onChange={onChange}
        placeholder="production"
        pattern={NAME_PATTERN}
      />
    </Box>
  );
}

interface VersionOption extends FormRadioOption {
  value: string;
}

function VersionStep({
  mode,
  value,
  versions,
  onChange,
  onNext,
  onBack,
}: {
  mode: "create" | "update";
  value: string;
  versions: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data?: Awaited<ReturnType<ScreenProps["core"]["harness"]["listHarnessVersions"]>>;
  };
  onChange: (version: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const options: VersionOption[] = useMemo(() => {
    const listed = (versions.data?.harnessVersions ?? [])
      .map((v) => ({
        value: v.harnessVersion ?? "",
        label: `version ${v.harnessVersion}`,
        description: `${v.status} · updated ${v.updatedAt?.toISOString().slice(0, 10) ?? ""}`,
      }))
      .sort((a, b) => Number(b.value) - Number(a.value));
    // Create mode offers "latest": omitting targetVersion tracks the newest
    // version at creation time.
    return mode === "create"
      ? [
          {
            value: "",
            label: "latest",
            description: "track the most recent version (default)",
          },
          ...listed,
        ]
      : listed;
  }, [versions.data, mode]);

  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (options.length === 0) return;
    if (key.upArrow) {
      onChange(options[Math.max(0, index - 1)]!.value);
      return;
    }
    if (key.downArrow) {
      onChange(options[Math.min(options.length - 1, index + 1)]!.value);
      return;
    }
    if (key.return) onNext();
  });

  return (
    <Box flexDirection="column">
      {versions.isPending ? (
        <>
          <Question text="which harness version should this endpoint serve?" />
          <Spinner label="loading versions…" />
        </>
      ) : versions.isError ? (
        <>
          <Question text="which harness version should this endpoint serve?" />
          <Text color={theme.colors.error}>
            {glyphs.cross} {(versions.error as Error).message}
          </Text>
        </>
      ) : options.length === 0 ? (
        <>
          <Question text="which harness version should this endpoint serve?" />
          <Text color={theme.colors.muted}>this harness has no versions</Text>
        </>
      ) : (
        <FormRadioGroup
          helpText="which harness version should this endpoint serve?"
          options={options}
          focusedIndex={index}
        />
      )}
    </Box>
  );
}

function ReviewStep({
  verb,
  request,
  onSubmit,
  onBack,
}: {
  verb: string;
  request: unknown;
  onSubmit: () => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) onSubmit();
  });

  const api = verb === "create" ? "CreateHarnessEndpoint" : "UpdateHarnessEndpoint";
  return (
    <Box flexDirection="column">
      <Question text={`this request will be sent to ${api}`} />
      <CodeBlock
        language="json"
        showLineNumbers={false}
        showBorder={false}
        code={JSON.stringify(request, null, 2)}
      />
    </Box>
  );
}

function SuccessPanel({
  verb,
  endpointName,
  targetVersion,
  status,
  onContinue,
}: {
  verb: string;
  endpointName: string;
  targetVersion?: string;
  status?: string;
  onContinue: () => void;
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onContinue();
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success} bold>
        {glyphs.check} endpoint {verb}d
      </Text>
      <Text>
        {"  "}
        {endpointName}
        {targetVersion ? ` → v${targetVersion}` : ""}
        {status ? ` · ${status}` : ""}
      </Text>
      <Text color={theme.colors.muted}>{"  enter opens the endpoint"}</Text>
    </Box>
  );
}
