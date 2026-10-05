import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Box, useInput } from "ink";
import { useNavigate } from "react-router";
import { FormCheckboxMultiSelect } from "../../../../components/FormCheckboxMultiSelect";
import { FormRadioGroup } from "../../../../components/FormRadioGroup";
import {
  Step,
  Summary,
  TextField,
  Wizard,
  useKeyHints,
  useWizard,
  type Choice,
} from "../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { AgentCoreGateway } from "../../../../projectSchemas/gateway";
import { PolicyEngineNameSchema } from "../../../../projectSchemas/policy";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { LoadingFrame, ProjectGate, projectQueryKey, useProjectTargets } from "../../ProjectGate";
import { requireDeployedNameFits } from "../shared";
import {
  POLICY_ENGINE_DEPLOYED_NAME_MAX,
  toAddPolicyEngineInput,
  type AttachMode,
  type PolicyEngineInput,
} from "./index";
import { RegionKey } from "../../../keys";

const BREADCRUMB = ["agentcore", "add", "policy-engine"];
const DESCRIPTION = "add a Policy Engine to the current project";
const ADD_MENU = "/agentcore/add";

const MODE_CHOICES: Choice<AttachMode>[] = [
  {
    value: "enforce",
    label: "enforce (default)",
    description: "deny the calls the engine's policies forbid",
  },
  {
    value: "log-only",
    label: "log-only",
    description: "record what the policies would decide, without blocking",
  },
];

type PolicyEngineFormValues = {
  name: string;
  // The Gateways to attach the engine to, in the order the project lists them.
  attached: string[];
  mode: AttachMode;
};

// toPolicyEngineInput is the answers as the flag path would state them: no
// attachment at all when no Gateway was picked, exactly as omitting
// --attach-to-gateways does. --description, --encryption-key-arn and --tags
// stay flag-only.
export function toPolicyEngineInput(values: PolicyEngineFormValues): PolicyEngineInput {
  const attaches = values.attached.length > 0;
  return {
    name: values.name,
    attachToGateways: attaches ? values.attached : undefined,
    attachMode: attaches ? values.mode : undefined,
  };
}

function summaryOf(values: PolicyEngineFormValues): Record<string, string> {
  const attaches = values.attached.length > 0;
  return {
    "policy engine": values.name,
    // The row is always shown, so the review says what an empty selection
    // means: the engine exists on its own and can be attached later.
    gateways: attaches ? values.attached.join(", ") : "(none) · attach from a Gateway later",
    ...(attaches ? { mode: values.mode } : {}),
  };
}

export function AddPolicyEngineScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => (
        <AddPolicyEngineLoader project={project} core={core} region={ctx.value(RegionKey)} />
      )}
    </ProjectGate>
  );
}

function AddPolicyEngineLoader({
  project,
  core,
  region,
}: {
  project: Project;
  core: ScreenProps["core"];
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const targets = useProjectTargets(core, project);

  if (targets.data !== undefined) {
    return (
      <AddPolicyEngineWizard project={project} targets={targets.data} core={core} region={region} />
    );
  }

  return (
    <LoadingFrame
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      query={targets}
      loadingLabel="loading deployment targets…"
      onBack={() => navigate(ADD_MENU)}
    />
  );
}

function AddPolicyEngineWizard({
  project,
  targets,
  core,
  region,
}: {
  project: Project;
  targets: readonly AwsDeploymentTarget[];
  core: ScreenProps["core"];
  /** The command\'s resolved region, for the China gate of a project without targets. */
  region: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const gateways = project.spec.agentCoreGateways ?? [];
  const [values, setValues] = useState<PolicyEngineFormValues>({
    name: "",
    attached: [],
    mode: "enforce",
  });
  const set = (update: Partial<PolicyEngineFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  // The deployed name is <project>_<target>_<name> and must fit the service
  // cap, so the live check reports the real budget rather than the schema's 48.
  const nameSchema = useMemo(
    () =>
      PolicyEngineNameSchema.superRefine((name, ctx) => {
        try {
          requireDeployedNameFits(
            "Policy Engine",
            project.name,
            name,
            "_",
            POLICY_ENGINE_DEPLOYED_NAME_MAX,
            targets,
          );
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    [project.name, targets],
  );

  const attaches = values.attached.length > 0;

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddPolicyEngineInput(project, targets, toPolicyEngineInput(values)),
          { region },
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding Policy Engine ${values.name}…`}
      successLabel={`added Policy Engine '${values.name}' to '${project.name}'`}
      successHint={
        attaches
          ? `attached to ${values.attached.length} ${values.attached.length === 1 ? "Gateway" : "Gateways"} in ${values.mode} mode`
          : undefined
      }
      // Bare, so it opens the policy wizard, which asks for the engine; naming
      // the engine with --engine would select the headless path instead.
      successNextSteps={["agentcore add policy", "agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this Policy Engine be called?">
        <TextField
          label="Policy Engine name"
          help={`letters, digits and underscores, starting with a letter; the deployed <project>_<target>_<name> must fit ${POLICY_ENGINE_DEPLOYED_NAME_MAX} characters`}
          placeholder="Guardrails"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      {/* Skipped when the project has no Gateways: there is nothing to attach
          to, and the engine can be attached from a Gateway later. */}
      {gateways.length > 0 && (
        <Step stepKey="gateways" prompt="attach it to any Gateways now?">
          <GatewayAttachmentField
            gateways={gateways}
            attached={values.attached}
            mode={values.mode}
            onChange={(update) => set(update)}
          />
        </Step>
      )}

      <Step stepKey="review" prompt="this Policy Engine will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}

// GatewayAttachmentField is a compound field: a checklist of the project's
// Gateways and, once any is checked, the enforcement mode for those
// attachments revealed beneath it — the question exists only once a Gateway is
// picked, which is the `--attach-mode requires --attach-to-gateways` rule. The
// checklist has focus first; enter (or down past the last Gateway) moves into
// the mode rows when there are attachments, and enter there continues. Enter
// with nothing checked continues straight away.
function GatewayAttachmentField({
  gateways,
  attached,
  mode,
  onChange,
}: {
  gateways: readonly AgentCoreGateway[];
  attached: string[];
  mode: AttachMode;
  onChange: (update: Partial<Pick<PolicyEngineFormValues, "attached" | "mode">>) => void;
}) {
  const { advance, back } = useWizard();
  const [focused, setFocused] = useState<"gateways" | "mode">("gateways");
  const [cursor, setCursor] = useState(0);
  const modeIndex = Math.max(
    0,
    MODE_CHOICES.findIndex((choice) => choice.value === mode),
  );
  const attaches = attached.length > 0;

  useKeyHints([
    { key: "↑↓", label: "navigate" },
    { key: "space", label: "toggle" },
    { key: "enter", label: "continue" },
  ]);

  useInput((input, key) => {
    if (key.escape) {
      back();
      return;
    }

    if (focused === "gateways") {
      if (key.upArrow) {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        if (cursor < gateways.length - 1) setCursor(cursor + 1);
        else if (attaches) setFocused("mode");
        return;
      }
      if (input === " ") {
        const name = gateways[cursor]!.name;
        const toggled = attached.includes(name)
          ? attached.filter((candidate) => candidate !== name)
          : [...attached, name];
        // Kept in the project's order, so the review and the spec agree.
        onChange({
          attached: gateways
            .filter((gateway) => toggled.includes(gateway.name))
            .map((gateway) => gateway.name),
        });
        return;
      }
      if (key.return) {
        if (attaches) setFocused("mode");
        else advance();
      }
      return;
    }

    if (key.upArrow) {
      if (modeIndex === 0) setFocused("gateways");
      else onChange({ mode: MODE_CHOICES[modeIndex - 1]!.value });
      return;
    }
    if (key.downArrow) {
      onChange({ mode: MODE_CHOICES[Math.min(MODE_CHOICES.length - 1, modeIndex + 1)]!.value });
      return;
    }
    if (key.return) advance();
  });

  return (
    <Box flexDirection="column">
      <FormCheckboxMultiSelect
        name=""
        helpText="optional · space toggles a Gateway; the engine can also be attached from a Gateway later"
        options={gateways.map((gateway) => ({
          label: gateway.name,
          description: `${gateway.targets.length} ${gateway.targets.length === 1 ? "Target" : "Targets"}`,
          checked: attached.includes(gateway.name),
        }))}
        cursorIndex={focused === "gateways" ? cursor : -1}
      />
      {attaches && (
        <FormRadioGroup
          name="Enforcement on those Gateways"
          helpText=""
          options={MODE_CHOICES.map((choice) => ({
            label: choice.label,
            description: choice.description ?? "",
          }))}
          focusedIndex={focused === "mode" ? modeIndex : undefined}
          selectedIndex={modeIndex}
        />
      )}
    </Box>
  );
}
