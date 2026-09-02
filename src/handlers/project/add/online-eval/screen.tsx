import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import { OnlineEvalConfigNameSchema } from "../../../../projectSchemas/online-eval-config";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  MultiChoiceField,
  Summary,
  splitList,
} from "../../../../components/wizard";
import {
  emptyMonitoringValues,
  monitoringSummary,
  toMonitoringInput,
  useMonitoringSteps,
  type MonitoringFormValues,
} from "../monitoring-steps";
import { toAddOnlineEvalInput, type OnlineEvalInput } from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "online-eval"];
const DESCRIPTION = "adds an online evaluation config to the current project";
const ADD_MENU = "/agentcore/project/add";

interface OnlineEvalFormValues extends MonitoringFormValues {
  // projectEvaluators are picked from the project's own; otherEvaluators are
  // typed — Builtin.* IDs or ARNs — so both routes to --evaluator are open.
  projectEvaluators: string[];
  otherEvaluators: string;
}

export function toOnlineEvalInput(values: OnlineEvalFormValues): OnlineEvalInput {
  const evaluators = [...values.projectEvaluators, ...(splitList(values.otherEvaluators) ?? [])];
  return {
    ...toMonitoringInput(values),
    evaluators: evaluators.length === 0 ? undefined : evaluators,
  };
}

function summaryOf(values: OnlineEvalFormValues): Record<string, string> {
  return {
    "online eval": values.name.trim(),
    ...monitoringSummary(values),
    evaluators: toOnlineEvalInput(values).evaluators?.join(", ") ?? "",
  };
}

export function AddOnlineEvalScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddOnlineEvalWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddOnlineEvalWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<OnlineEvalFormValues>(() => ({
    ...emptyMonitoringValues(project),
    projectEvaluators: [],
    otherEvaluators: "",
  }));
  const set = (update: Partial<OnlineEvalFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  const { sourceSteps, trailingSteps } = useMonitoringSteps(project, values, set, "evaluation");

  const evaluatorChoices = useMemo(
    () =>
      project.spec.evaluators.map((evaluator) => ({
        value: evaluator.name,
        label: evaluator.name,
        description: evaluator.description ?? evaluator.level,
      })),
    [project.spec.evaluators],
  );
  const hasProjectEvaluators = evaluatorChoices.length > 0;

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(project, toAddOnlineEvalInput(toOnlineEvalInput(values)))
      }
      runningLabel={`adding online-eval config ${values.name.trim()}…`}
      successLabel={`added online-eval config '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this online evaluation config be called?">
        <TextField
          label="config name"
          placeholder="prod_quality"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={OnlineEvalConfigNameSchema}
        />
      </Step>

      {sourceSteps}

      {hasProjectEvaluators && (
        <Step
          name="project-evaluators"
          title="evaluators"
          question="which of this project's evaluators should score the sessions?"
        >
          <MultiChoiceField
            label="evaluator"
            help="built-in evaluators can be added on the next step"
            choices={evaluatorChoices}
            value={values.projectEvaluators}
            onChange={(projectEvaluators) => set({ projectEvaluators })}
          />
        </Step>
      )}

      <Step
        name="other-evaluators"
        title={hasProjectEvaluators ? "built-in" : "evaluators"}
        question={
          hasProjectEvaluators
            ? "any built-in evaluators as well? (optional)"
            : "which evaluators should score the sessions?"
        }
      >
        <TextField
          label="evaluators"
          help="Builtin.* IDs or evaluator ARNs, comma-separated"
          placeholder="Builtin.Helpfulness, Builtin.Correctness"
          value={values.otherEvaluators}
          onChange={(otherEvaluators) => set({ otherEvaluators })}
          // The schema wants at least one evaluator; this is the last chance.
          required={values.projectEvaluators.length === 0}
        />
      </Step>

      {trailingSteps}

      <Step name="review" question="this config will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
