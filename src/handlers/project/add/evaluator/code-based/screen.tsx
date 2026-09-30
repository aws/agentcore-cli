import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  ChoiceField,
  RevealChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../../projectSchemas/aws-targets";
import {
  DEFAULT_CODE_BASED_TIMEOUT_SECONDS,
  ExternalCodeBasedConfigSchema,
  type EvaluationLevel,
} from "../../../../../projectSchemas/evaluator";
import { ProjectKey } from "../../../../../router";
import type { ScreenProps } from "../../../../types";
import type { Project } from "../../../types";
import {
  LoadingFrame,
  ProjectGate,
  projectQueryKey,
  useProjectTargets,
} from "../../../ProjectGate";
import { EVALUATOR_MENU, EVALUATOR_NAME_HELP, evaluatorNameSchema, LEVEL_CHOICES } from "../shared";
import {
  scaffoldedEvaluatorNote,
  TimeoutSecondsSchema,
  toAddCodeBasedEvaluatorInput,
  type CodeBasedEvaluatorInput,
} from "./index";

const BREADCRUMB = ["agentcore", "add", "evaluator", "code-based"];
const DESCRIPTION = "add a code-based evaluator to the current project";

type LambdaSource = "scaffold" | "existing";

type CodeBasedFormValues = {
  name: string;
  level: EvaluationLevel;
  lambda: LambdaSource;
  lambdaArn: string;
  timeoutSeconds: string;
};

function lambdaChoices(name: string): Choice<LambdaSource>[] {
  return [
    {
      value: "scaffold",
      label: "scaffold a new Lambda",
      description: `Python code in app/${name || "<name>"}, deployed with the project`,
    },
    {
      value: "existing",
      label: "use an existing Lambda",
      description: "a Lambda function deployed outside this project",
    },
  ];
}

export function toCodeBasedInput(values: CodeBasedFormValues): CodeBasedEvaluatorInput {
  const base = { name: values.name, level: values.level };
  return values.lambda === "existing"
    ? { ...base, lambdaArn: values.lambdaArn }
    : { ...base, timeoutSeconds: Number(values.timeoutSeconds) };
}

function summaryOf(values: CodeBasedFormValues): Record<string, string> {
  const scaffolds = values.lambda === "scaffold";
  return {
    evaluator: values.name,
    level: values.level,
    lambda: scaffolds ? `scaffolded in app/${values.name}` : values.lambdaArn,
    ...(scaffolds ? { timeout: `${values.timeoutSeconds} seconds` } : {}),
  };
}

export function AddCodeBasedEvaluatorScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(EVALUATOR_MENU)}
    >
      {(project) => <AddCodeBasedEvaluatorLoader project={project} core={core} />}
    </ProjectGate>
  );
}

function AddCodeBasedEvaluatorLoader({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const targets = useProjectTargets(core, project);

  if (targets.data !== undefined) {
    return <AddCodeBasedEvaluatorWizard project={project} targets={targets.data} core={core} />;
  }

  return (
    <LoadingFrame
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      query={targets}
      loadingLabel="loading deployment targets…"
      onBack={() => navigate(EVALUATOR_MENU)}
    />
  );
}

function AddCodeBasedEvaluatorWizard({
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
  const [values, setValues] = useState<CodeBasedFormValues>({
    name: "",
    level: "SESSION",
    lambda: "scaffold",
    lambdaArn: "",
    timeoutSeconds: String(DEFAULT_CODE_BASED_TIMEOUT_SECONDS),
  });
  const set = (update: Partial<CodeBasedFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const nameSchema = useMemo(
    () => evaluatorNameSchema(project.name, targets),
    [project.name, targets],
  );
  const scaffolds = values.lambda === "scaffold";

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(EVALUATOR_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddCodeBasedEvaluatorInput(project, targets, toCodeBasedInput(values)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding evaluator ${values.name}…`}
      successLabel={`added evaluator '${values.name}' to '${project.name}'`}
      successNotes={scaffolds ? [scaffoldedEvaluatorNote(values.name)] : undefined}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(EVALUATOR_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this evaluator be called?">
        <TextField
          label="Name"
          help={EVALUATOR_NAME_HELP}
          placeholder="refund_policy"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={nameSchema}
          live
        />
      </Step>

      <Step stepKey="level" prompt="what should it score?">
        <ChoiceField
          choices={LEVEL_CHOICES}
          value={values.level}
          onChange={(level) => set({ level })}
        />
      </Step>

      <Step stepKey="lambda" prompt="which Lambda should score it?">
        <RevealChoiceField
          choices={lambdaChoices(values.name)}
          value={values.lambda}
          onChange={(lambda) => set({ lambda })}
          input={{
            opensFor: (lambda) => lambda === "existing",
            label: "Lambda ARN",
            name: "Lambda ARN",
            help: "the ARN of the function that scores each evaluation",
            placeholder: "arn:aws:lambda:us-west-2:123456789012:function:refund-policy",
            value: values.lambdaArn,
            onChange: (lambdaArn) => set({ lambdaArn }),
            required: true,
            schema: ExternalCodeBasedConfigSchema.shape.lambdaArn,
          }}
        />
      </Step>

      {scaffolds && (
        <Step stepKey="timeout" prompt="how long may it run?">
          <TextField
            label="Timeout"
            help="in seconds, between 1 and 300"
            value={values.timeoutSeconds}
            onChange={(timeoutSeconds) => set({ timeoutSeconds })}
            required
            number
            schema={TimeoutSecondsSchema}
          />
        </Step>
      )}

      <Step stepKey="review" prompt="this evaluator will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
