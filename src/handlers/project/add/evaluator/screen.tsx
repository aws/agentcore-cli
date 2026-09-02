import { useState } from "react";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import { RouterScreen } from "../../../../components/RouterScreen";
import {
  EvaluationLevelSchema,
  EvaluatorNameSchema,
  RatingScaleSchema,
  type EvaluationLevel,
} from "../../../../projectSchemas/evaluator";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  TextAreaField,
  ChoiceField,
  Summary,
  blankToUndefined,
} from "../../../../components/wizard";
import {
  JudgeModelSchema,
  resolveRatingScale,
  toAddLlmAsAJudgeEvaluatorInput,
  type LlmAsAJudgeEvaluatorInput,
} from "./llm-as-a-judge";
import {
  RATING_SCALE_PRESET_NAMES,
  RATING_SCALE_PRESETS,
  type RatingScalePreset,
} from "./llm-as-a-judge/ratingScales";

// AddEvaluatorScreen is the `agentcore project add evaluator` menu: evaluator
// is a command group, so its kinds are read off the Commander tree like the
// add menu's resources are.
export function AddEvaluatorScreen(props: ScreenProps) {
  return <RouterScreen {...props} path={["agentcore", "project", "add", "evaluator"]} />;
}

const BREADCRUMB = ["agentcore", "project", "add", "evaluator", "llm-as-a-judge"];
const DESCRIPTION =
  "add an LLM-as-a-Judge evaluator — another LLM prompted with instructions on how to score a session";
const EVALUATOR_MENU = "/agentcore/project/add/evaluator";

const LEVEL_DESCRIPTIONS: Record<EvaluationLevel, string> = {
  SESSION: "one score for the whole conversation",
  TRACE: "one score per agent turn",
  TOOL_CALL: "one score per tool invocation",
};

const LEVEL_CHOICES = EvaluationLevelSchema.options.map((level) => ({
  value: level,
  label: level,
  description: LEVEL_DESCRIPTIONS[level],
}));

// CUSTOM_SCALE is the picker entry that opens the JSON step.
const CUSTOM_SCALE = "\u0000custom";
type ScaleChoice = RatingScalePreset | typeof CUSTOM_SCALE;

function describePreset(preset: RatingScalePreset): string {
  const scale = RATING_SCALE_PRESETS[preset];
  const rungs = "numerical" in scale ? scale.numerical : scale.categorical;
  return rungs.map((rung) => rung.label).join(" · ");
}

const SCALE_CHOICES: { value: ScaleChoice; label: string; description: string }[] = [
  ...RATING_SCALE_PRESET_NAMES.map((preset) => ({
    value: preset as ScaleChoice,
    label: preset,
    description: describePreset(preset),
  })),
  { value: CUSTOM_SCALE, label: "custom", description: "paste a rating scale as JSON" },
];

interface EvaluatorFormValues {
  name: string;
  level: EvaluationLevel;
  model: string;
  instructions: string;
  scale: ScaleChoice;
  customScale: string;
  description: string;
}

// toLlmAsAJudgeEvaluatorInput reads the form into the input the handler's
// builder expects. The rating scale goes through the handler's own
// resolveRatingScale, whether a preset was picked or JSON was pasted, so the
// wizard's scale is exactly what `--rating-scale <same value>` produces.
export function toLlmAsAJudgeEvaluatorInput(
  values: EvaluatorFormValues,
): LlmAsAJudgeEvaluatorInput {
  return {
    name: values.name.trim(),
    level: values.level,
    model: values.model.trim(),
    instructions: values.instructions.trim(),
    ratingScale: resolveRatingScale(
      values.scale === CUSTOM_SCALE ? values.customScale.trim() : values.scale,
    ),
    description: blankToUndefined(values.description),
  };
}

function summaryOf(values: EvaluatorFormValues): Record<string, string> {
  return {
    evaluator: values.name.trim(),
    level: values.level,
    model: values.model.trim(),
    "rating scale": values.scale === CUSTOM_SCALE ? "custom" : values.scale,
    ...(values.description.trim() === "" ? {} : { description: values.description.trim() }),
  };
}

export function AddLlmAsAJudgeEvaluatorScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddLlmAsAJudgeEvaluatorWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddLlmAsAJudgeEvaluatorWizard({
  project,
  core,
}: {
  project: Project;
  core: ScreenProps["core"];
}) {
  const navigate = useNavigate();
  const [values, setValues] = useState<EvaluatorFormValues>({
    name: "",
    level: "SESSION",
    model: "",
    instructions: "",
    scale: RATING_SCALE_PRESET_NAMES[0]!,
    customScale: "",
    description: "",
  });
  const set = (update: Partial<EvaluatorFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(EVALUATOR_MENU)}
      onSubmit={() =>
        core.projectManager.addResource(
          project,
          toAddLlmAsAJudgeEvaluatorInput(toLlmAsAJudgeEvaluatorInput(values)),
        )
      }
      runningLabel={`adding evaluator ${values.name.trim()}…`}
      successLabel={`added evaluator '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this evaluator be called?">
        <TextField
          label="evaluator name"
          placeholder="helpfulness_judge"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={EvaluatorNameSchema}
        />
      </Step>

      <Step name="level" question="what should the judge score?">
        <ChoiceField
          choices={LEVEL_CHOICES}
          value={values.level}
          onChange={(level) => set({ level })}
        />
      </Step>

      <Step name="model" question="which Bedrock model should act as the judge?">
        <TextField
          label="model"
          help="a Bedrock model ID, or an inference-profile or foundation-model ARN"
          placeholder="anthropic.claude-3-5-sonnet-20240620-v1:0"
          value={values.model}
          onChange={(model) => set({ model })}
          required
          schema={JudgeModelSchema}
        />
      </Step>

      <Step name="instructions" question="how should the judge score a session?">
        <TextAreaField
          label="instructions"
          help="placeholders such as {context} are filled per level"
          placeholder="Rate how helpful the assistant was in {context}."
          value={values.instructions}
          onChange={(instructions) => set({ instructions })}
          required
        />
      </Step>

      <Step name="scale" title="rating scale" question="which rating scale should the judge use?">
        <ChoiceField
          choices={SCALE_CHOICES}
          value={values.scale}
          onChange={(scale) => set({ scale })}
        />
      </Step>

      {values.scale === CUSTOM_SCALE && (
        <Step name="custom-scale" title="custom scale" question="paste the rating scale as JSON">
          <TextField
            label="rating scale"
            help="either a numerical or a categorical list of rungs, not both"
            example='{"numerical": [{"value": 1, "label": "Bad", "definition": "…"}, {"value": 2, "label": "Good", "definition": "…"}]}'
            value={values.customScale}
            onChange={(customScale) => set({ customScale })}
            required
            json
            schema={RatingScaleSchema}
          />
        </Step>
      )}

      <Step name="description" question="what does this evaluator measure? (optional)">
        <TextField
          label="description"
          placeholder="how helpful the final answer was"
          value={values.description}
          onChange={(description) => set({ description })}
        />
      </Step>

      <Step name="review" question="this evaluator will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
