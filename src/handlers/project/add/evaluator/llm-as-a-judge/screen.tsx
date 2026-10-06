import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import z from "zod";
import {
  ChoiceField,
  promptPreview,
  RevealChoiceField,
  Step,
  Summary,
  TextAreaField,
  TextField,
  Wizard,
  type Choice,
} from "../../../../../components/wizard";
import type { AwsDeploymentTarget } from "../../../../../projectSchemas/aws-targets";
import {
  isValidEvaluatorModelId,
  type EvaluationLevel,
  type EvaluatorModelProvider,
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
  MODEL_ID_FORMATS,
  toAddLlmAsAJudgeEvaluatorInput,
  type LlmAsAJudgeEvaluatorInput,
} from "./index";
import {
  expandRatingScalePreset,
  RATING_SCALE_PRESET_NAMES,
  RATING_SCALE_PRESETS,
  type RatingScalePreset,
} from "./ratingScales";

const BREADCRUMB = ["agentcore", "add", "evaluator", "llm-as-a-judge"];
const DESCRIPTION = "add an LLM-as-a-Judge evaluator to the current project";

const PROVIDER_CHOICES: Choice<EvaluatorModelProvider>[] = [
  {
    value: "Bedrock",
    label: "Bedrock",
    description: "Anthropic Claude and other models on Amazon Bedrock",
  },
  {
    value: "OpenResponses",
    label: "OpenResponses",
    description: "an OpenAI model on Bedrock through the OpenResponses API",
  },
];

/** The Evaluator service sends a temperature, which Claude models from Opus 4.7 on refuse. **/
export const DEFAULT_JUDGE_MODEL = "global.anthropic.claude-sonnet-5-5";

const MODEL_PLACEHOLDERS: Record<EvaluatorModelProvider, string> = {
  Bedrock: DEFAULT_JUDGE_MODEL,
  OpenResponses: "openai.gpt-5.4",
};

function ratingScaleDescription(preset: RatingScalePreset): string {
  const scale = RATING_SCALE_PRESETS[preset];
  return "numerical" in scale
    ? `numerical · ${scale.numerical.map((rung) => `${rung.value} ${rung.label}`).join(", ")}`
    : `categorical · ${scale.categorical.map((rung) => rung.label).join(", ")}`;
}

const RATING_SCALE_CHOICES: Choice<RatingScalePreset>[] = RATING_SCALE_PRESET_NAMES.map(
  (preset) => ({ value: preset, label: preset, description: ratingScaleDescription(preset) }),
);

type LlmAsAJudgeFormValues = {
  name: string;
  level: EvaluationLevel;
  modelProvider: EvaluatorModelProvider;
  models: Record<EvaluatorModelProvider, string>;
  instructions: string;
  ratingScale: RatingScalePreset;
};

export function toLlmAsAJudgeInput(values: LlmAsAJudgeFormValues): LlmAsAJudgeEvaluatorInput {
  return {
    name: values.name,
    level: values.level,
    modelProvider: values.modelProvider,
    model: values.models[values.modelProvider].trim(),
    instructions: values.instructions,
    ratingScale: expandRatingScalePreset(values.ratingScale),
  };
}

function summaryOf(values: LlmAsAJudgeFormValues): Record<string, string> {
  return {
    evaluator: values.name,
    level: values.level,
    provider: values.modelProvider,
    model: values.models[values.modelProvider].trim(),
    instructions: promptPreview(values.instructions),
    "rating scale": values.ratingScale,
  };
}

function modelSchema(provider: EvaluatorModelProvider): z.ZodType<string> {
  return z
    .string()
    .refine(
      (model) => isValidEvaluatorModelId(provider, model.trim()),
      `Must be ${MODEL_ID_FORMATS[provider]}`,
    );
}

export function AddLlmAsAJudgeEvaluatorScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(EVALUATOR_MENU)}
    >
      {(project) => <AddLlmAsAJudgeEvaluatorLoader project={project} core={core} />}
    </ProjectGate>
  );
}

function AddLlmAsAJudgeEvaluatorLoader({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const targets = useProjectTargets(core, project);

  if (targets.data !== undefined) {
    return <AddLlmAsAJudgeEvaluatorWizard project={project} targets={targets.data} core={core} />;
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

function AddLlmAsAJudgeEvaluatorWizard({
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
  const [values, setValues] = useState<LlmAsAJudgeFormValues>({
    name: "",
    level: "SESSION",
    modelProvider: "Bedrock",
    models: { Bedrock: DEFAULT_JUDGE_MODEL, OpenResponses: "" },
    instructions: "",
    ratingScale: "1-5-quality",
  });
  const set = (update: Partial<LlmAsAJudgeFormValues>) =>
    setValues((current) => ({ ...current, ...update }));
  const nameSchema = useMemo(
    () => evaluatorNameSchema(project.name, targets),
    [project.name, targets],
  );
  const provider = values.modelProvider;

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(EVALUATOR_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddLlmAsAJudgeEvaluatorInput(toLlmAsAJudgeInput(values)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding evaluator ${values.name}…`}
      successLabel={`added evaluator '${values.name}' to '${project.name}'`}
      successNextSteps={["agentcore deploy"]}
      onDone={() => navigate(EVALUATOR_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this evaluator be called?">
        <TextField
          label="Name"
          help={EVALUATOR_NAME_HELP}
          placeholder="helpfulness"
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

      <Step stepKey="model" prompt="which model should judge?">
        <RevealChoiceField
          choices={PROVIDER_CHOICES}
          value={provider}
          onChange={(modelProvider) => set({ modelProvider })}
          input={{
            opensFor: () => true,
            label: "Model ID",
            name: "model ID",
            help: MODEL_ID_FORMATS[provider],
            placeholder: MODEL_PLACEHOLDERS[provider],
            value: values.models[provider],
            onChange: (model) => set({ models: { ...values.models, [provider]: model } }),
            required: true,
            schema: modelSchema(provider),
          }}
        />
      </Step>

      <Step stepKey="instructions" prompt="how should the judge score it?">
        <TextAreaField
          label="Instructions"
          help="enter for a new line, ctrl+d to continue"
          example="Rate how well the agent resolved the user's request. Conversation: {context}"
          value={values.instructions}
          onChange={(instructions) => set({ instructions })}
          required
        />
      </Step>

      <Step stepKey="rating-scale" title="scale" prompt="which rating scale?">
        <ChoiceField
          choices={RATING_SCALE_CHOICES}
          value={values.ratingScale}
          onChange={(ratingScale) => set({ ratingScale })}
        />
      </Step>

      <Step stepKey="review" prompt="this evaluator will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
