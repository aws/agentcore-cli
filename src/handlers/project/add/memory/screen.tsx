import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import {
  MemoryNameSchema,
  MemoryStrategyTypeSchema,
  type MemoryStrategyType,
} from "../../../../projectSchemas/memory";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate, projectQueryKey } from "../../ProjectGate";
import {
  MultiChoiceField,
  Step,
  Summary,
  TextField,
  Wizard,
  type Choice,
} from "../../../../components/wizard";
import {
  DEFAULT_EVENT_EXPIRY_DURATION,
  EventExpiryDurationSchema,
  toAddMemoryInput,
  toDefaultStrategy,
  type MemoryInput,
} from "./index";

const BREADCRUMB = ["agentcore", "project", "add", "memory"];
const DESCRIPTION = "add a Memory to the current project";
const ADD_MENU = "/agentcore/project/add";

const STRATEGY_DESCRIPTIONS: Record<MemoryStrategyType, string> = {
  SEMANTIC: "durable facts about the actor",
  SUMMARIZATION: "a running summary of each session",
  USER_PREFERENCE: "preferences the actor states",
  EPISODIC: "past episodes, with reflections over them",
};

const STRATEGY_CHOICES: Choice<MemoryStrategyType>[] = MemoryStrategyTypeSchema.options.map(
  (type) => ({
    value: type,
    label: type,
    description: STRATEGY_DESCRIPTIONS[type],
  }),
);

interface MemoryFormValues {
  name: string;
  strategies: MemoryStrategyType[];
  // The retention answer stays a string while it is being typed, so a
  // half-entered number is not silently read as a different one.
  eventExpiryDuration: string;
}

export function toMemoryInput(values: MemoryFormValues): MemoryInput {
  return {
    name: values.name,
    eventExpiryDuration: Number(values.eventExpiryDuration),
    // The same expansion `--strategies SEMANTIC,EPISODIC` gets, so a memory
    // added here and one added with flags carry the same namespaces.
    strategies: values.strategies.map(toDefaultStrategy),
  };
}

function summaryOf(values: MemoryFormValues): Record<string, string> {
  return {
    memory: values.name,
    // The row is always shown, so the review says what an empty selection means:
    // no long-term strategies is a memory that only keeps raw events.
    strategies:
      values.strategies.length === 0
        ? "(none) · short-term memory only"
        : values.strategies.join(", "),
    "event retention": `${values.eventExpiryDuration} days`,
  };
}

export function AddMemoryScreen({ ctx, core }: ScreenProps) {
  const navigate = useNavigate();
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
      onBack={() => navigate(ADD_MENU)}
    >
      {(project) => <AddMemoryWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddMemoryWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<MemoryFormValues>({
    name: "",
    strategies: [],
    eventExpiryDuration: String(DEFAULT_EVENT_EXPIRY_DURATION),
  });
  const set = (update: Partial<MemoryFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate(ADD_MENU)}
      onSubmit={async function* () {
        const updated = yield* core.projectManager.addResource(
          project,
          toAddMemoryInput(toMemoryInput(values)),
        );
        queryClient.setQueryData(projectQueryKey(), updated);
        return updated;
      }}
      runningLabel={`adding memory ${values.name}…`}
      successLabel={`added memory '${values.name}' to '${project.name}'`}
      onDone={() => navigate(ADD_MENU)}
      doneLabel="go back"
    >
      <Step stepKey="name" prompt="what should this Memory be called?">
        <TextField
          label="Name"
          help="letters, digits and underscores, starting with a letter (max 48)"
          placeholder="orders_memory"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={MemoryNameSchema}
          live
        />
      </Step>

      <Step stepKey="strategies" prompt="what should be extracted into long-term memory?">
        <MultiChoiceField
          help="select none to keep raw events only · space toggles"
          choices={STRATEGY_CHOICES}
          value={values.strategies}
          onChange={(strategies) => set({ strategies })}
        />
      </Step>

      <Step stepKey="retention" prompt="how long should raw events be kept?">
        <TextField
          label="Event retention"
          help="in days, between 3 and 365"
          value={values.eventExpiryDuration}
          onChange={(eventExpiryDuration) => set({ eventExpiryDuration })}
          required
          number
          schema={EventExpiryDurationSchema}
        />
      </Step>

      <Step stepKey="review" prompt="this Memory will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
