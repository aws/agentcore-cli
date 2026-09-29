import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import z from "zod";
import {
  MultiChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import { OnlineEvalConfigNameSchema } from "../../../../projectSchemas/online-eval-config";
import { ProjectKey } from "../../../../router";
import type { ScreenProps } from "../../../types";
import { LoadingFrame, ProjectGate, projectQueryKey, useProjectTargets } from "../../ProjectGate";
import type { Project } from "../../types";
import { requireDeployedNameFits } from "../shared";
import {
  initialTrafficSourceValues,
  toTrafficSourceInput,
  trafficSourceSteps,
  trafficSourceSummary,
  type TrafficSourceFormValues,
} from "../traffic-source-fields";
import {
  ONLINE_EVAL_DEPLOYED_NAME_MAX_LENGTH,
  toAddOnlineEvalInput,
  type OnlineEvalInput,
} from "./index";

const BREADCRUMB = ["agentcore", "add", "online-eval"];
const DESCRIPTION = "add an online evaluation config to the current project";
const ADD_MENU = "/agentcore/add";

const BUILTIN_EVALUATOR_CHOICES: Choice<string>[] = [
  {
    value: "Builtin.Correctness",
    label: "Builtin.Correctness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Faithfulness",
    label: "Builtin.Faithfulness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Helpfulness",
    label: "Builtin.Helpfulness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.ResponseRelevance",
    label: "Builtin.ResponseRelevance",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Conciseness",
    label: "Builtin.Conciseness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Coherence",
    label: "Builtin.Coherence",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.InstructionFollowing",
    label: "Builtin.InstructionFollowing",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Refusal",
    label: "Builtin.Refusal",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.GoalSuccessRate",
    label: "Builtin.GoalSuccessRate",
    description: "SESSION evaluator",
  },
  {
    value: "Builtin.ToolSelectionAccuracy",
    label: "Builtin.ToolSelectionAccuracy",
    description: "TOOL_CALL evaluator",
  },
  {
    value: "Builtin.ToolParameterAccuracy",
    label: "Builtin.ToolParameterAccuracy",
    description: "TOOL_CALL evaluator",
  },
  {
    value: "Builtin.Harmfulness",
    label: "Builtin.Harmfulness",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.Stereotyping",
    label: "Builtin.Stereotyping",
    description: "TRACE evaluator",
  },
  {
    value: "Builtin.TrajectoryExactOrderMatch",
    label: "Builtin.TrajectoryExactOrderMatch",
    description: "SESSION evaluator",
  },
  {
    value: "Builtin.TrajectoryInOrderMatch",
    label: "Builtin.TrajectoryInOrderMatch",
    description: "SESSION evaluator",
  },
  {
    value: "Builtin.TrajectoryAnyOrderMatch",
    label: "Builtin.TrajectoryAnyOrderMatch",
    description: "SESSION evaluator",
  },
];

interface OnlineEvalFormValues extends TrafficSourceFormValues {
  name: string;
  evaluators: string[];
  samplingRate: string;
}

function firstError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toOnlineEvalInput(values: OnlineEvalFormValues): OnlineEvalInput {
  return {
    name: values.name,
    ...toTrafficSourceInput(values),
    evaluators: values.evaluators,
    samplingRate: Number(values.samplingRate),
  };
}

function summaryOf(values: OnlineEvalFormValues): Record<string, string> {
  return {
    config: values.name,
    ...trafficSourceSummary(values),
    evaluators: values.evaluators.join(", "),
    sampling: `${values.samplingRate}%`,
  };
}

export function AddOnlineEvalScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => <AddOnlineEvalLoader project={project} core={core} />}
    </ProjectGate>
  );
}

function AddOnlineEvalLoader({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const targets = useProjectTargets(core, project);

  if (targets.data !== undefined) {
    return <AddOnlineEvalWizard project={project} targets={targets.data} core={core} />;
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

function AddOnlineEvalWizard({
  project,
  targets,
  core,
}: {
  project: Project;
  targets: readonly AwsDeploymentTarget[];
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runtimes = project.spec.runtimes;
  const initialRuntime = runtimes[0]?.name ?? "";
  const [values, setValues] = useState<OnlineEvalFormValues>({
    ...initialTrafficSourceValues(initialRuntime),
    name: "",
    evaluators: [],
    samplingRate: "",
  });
  const set = (update: Partial<OnlineEvalFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const evaluatorChoices: Choice<string>[] = [
    ...project.spec.evaluators.map((evaluator) => ({
      value: evaluator.name,
      label: evaluator.name,
      description: `${evaluator.level} project evaluator`,
    })),
    ...BUILTIN_EVALUATOR_CHOICES,
  ];

  const nameSchema = useMemo(
    () =>
      OnlineEvalConfigNameSchema.superRefine((name, ctx) => {
        try {
          requireDeployedNameFits(
            "Online-eval config",
            project.name,
            name,
            "_",
            ONLINE_EVAL_DEPLOYED_NAME_MAX_LENGTH,
            targets,
          );
        } catch (error) {
          ctx.addIssue({ code: "custom", message: firstError(error) });
        }
      }),
    [project.name, targets],
  );

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddOnlineEvalInput(project, targets, toOnlineEvalInput(values)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding online evaluation config ${values.name}…`}
      successLabel={`added online-eval config '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this online evaluation config be called?">
        <TextField
          label="Name"
          help="letters, digits and underscores, starting with a letter; the deployed <project>_<target>_<name> must fit 48 characters"
          placeholder="production_quality"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      {trafficSourceSteps({ values, runtimes, onChange: set })}

      <Step stepKey="evaluators" prompt="which evaluators should score it?">
        <MultiChoiceField
          help="project and built-in evaluators · space toggles"
          choices={evaluatorChoices}
          value={values.evaluators}
          onChange={(evaluators) => set({ evaluators })}
          minSelections={1}
          minSelectionsMessage="Select at least one evaluator"
        />
      </Step>

      <Step stepKey="sampling" prompt="what percentage of sessions should be sampled?">
        <TextField
          label="Sampling rate"
          help="a percentage from 0.01 through 100"
          placeholder="10"
          value={values.samplingRate}
          onChange={(samplingRate) => set({ samplingRate })}
          required
          decimal
          schema={z.number().min(0.01).max(100)}
        />
      </Step>

      <Step stepKey="review" prompt="this online evaluation config will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
