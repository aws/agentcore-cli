import { useState } from "react";
import { useNavigate } from "react-router";
import { ProjectKey } from "../../../../router";
import {
  MemoryNameSchema,
  MemoryStrategyTypeSchema,
  type MemoryStrategyType,
} from "../../../../projectSchemas/memory";
import type { ScreenProps } from "../../../types";
import type { Project } from "../../types";
import { ProjectGate } from "../../ProjectGate";
import {
  Wizard,
  Step,
  TextField,
  MultiChoiceField,
  Summary,
  blankToUndefined,
  numberSchema,
} from "../../../../components/wizard";
import {
  DEFAULT_EVENT_EXPIRY_DURATION,
  EventExpiryDurationSchema,
  toAddMemoryInput,
  toDefaultStrategy,
  type MemoryInput,
} from "./index";

// The retention step collects text, so the flag's numeric bounds are reached
// through a coercion; the bounds themselves are the flag's.
const ExpiryInputSchema = numberSchema(EventExpiryDurationSchema, "enter a number of days");

const BREADCRUMB = ["agentcore", "project", "add", "memory"];
const DESCRIPTION = "adds a memory to the current project";

// STRATEGY_CHOICES mirrors --strategies' comma-separated shorthand, which is
// the form the flag documents first. The enum is read from the schema so the
// picker cannot drift from what the flag accepts.
const STRATEGY_DESCRIPTIONS: Record<MemoryStrategyType, string> = {
  SEMANTIC: "durable facts extracted from conversations",
  SUMMARIZATION: "running summaries of each session",
  USER_PREFERENCE: "preferences the user states or implies",
  EPISODIC: "past episodes, plus reflections over them",
};

const STRATEGY_CHOICES = MemoryStrategyTypeSchema.options.map((type) => ({
  value: type,
  label: type,
  description: STRATEGY_DESCRIPTIONS[type],
}));

interface MemoryFormValues {
  name: string;
  strategies: MemoryStrategyType[];
  expiry: string;
  description: string;
}

// toMemoryInput reads the form into the MemoryInput the handler's
// toAddMemoryInput builds a memory from. It trims and converts; the one piece
// of handler logic it reaches for, toDefaultStrategy, is the handler's own, so
// a picked strategy expands to the same namespaces `--strategies SEMANTIC` does.
export function toMemoryInput(values: MemoryFormValues): MemoryInput {
  return {
    name: values.name.trim(),
    description: blankToUndefined(values.description),
    eventExpiryDuration: Number(values.expiry),
    strategies:
      values.strategies.length === 0 ? undefined : values.strategies.map(toDefaultStrategy),
  };
}

function summaryOf(values: MemoryFormValues): Record<string, string> {
  return {
    memory: values.name.trim(),
    strategies: values.strategies.length === 0 ? "none" : values.strategies.join(", "),
    "event expiry": `${values.expiry} days`,
    ...(values.description.trim() === "" ? {} : { description: values.description.trim() }),
  };
}

export function AddMemoryScreen({ ctx, core }: ScreenProps) {
  return (
    <ProjectGate
      core={core}
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      seed={ctx.value(ProjectKey)}
    >
      {(project) => <AddMemoryWizard project={project} core={core} />}
    </ProjectGate>
  );
}

function AddMemoryWizard({ project, core }: { project: Project; core: ScreenProps["core"] }) {
  const navigate = useNavigate();
  const [values, setValues] = useState<MemoryFormValues>({
    name: "",
    strategies: ["SEMANTIC"],
    expiry: String(DEFAULT_EVENT_EXPIRY_DURATION),
    description: "",
  });
  const set = (update: Partial<MemoryFormValues>) =>
    setValues((current) => ({ ...current, ...update }));

  return (
    <Wizard
      breadcrumb={BREADCRUMB}
      description={DESCRIPTION}
      onCancel={() => navigate("/agentcore/project/add")}
      onSubmit={() =>
        core.projectManager.addResource(project, toAddMemoryInput(toMemoryInput(values)))
      }
      runningLabel={`adding memory ${values.name.trim()}…`}
      successLabel={`added memory '${values.name.trim()}' to '${project.name}'`}
      successHint="enter exits"
    >
      <Step name="name" question="what should this memory be called?">
        <TextField
          label="memory name"
          placeholder="conversations"
          value={values.name}
          onChange={(name) => set({ name })}
          required
          schema={MemoryNameSchema}
        />
      </Step>

      <Step name="strategies" question="what should be extracted from raw events?">
        <MultiChoiceField
          label="long-term memory strategies"
          help="selecting none keeps short-term events only"
          choices={STRATEGY_CHOICES}
          value={values.strategies}
          onChange={(strategies) => set({ strategies })}
        />
      </Step>

      <Step name="retention" title="retention" question="how long should raw events be kept?">
        <TextField
          label="event expiry, in days"
          help="3-365 · the service default is 30"
          placeholder={String(DEFAULT_EVENT_EXPIRY_DURATION)}
          value={values.expiry}
          onChange={(expiry) => set({ expiry })}
          required
          schema={ExpiryInputSchema}
        />
      </Step>

      <Step name="description" question="what does this memory store? (optional)">
        <TextField
          label="description"
          placeholder="user facts and session summaries"
          value={values.description}
          onChange={(description) => set({ description })}
        />
      </Step>

      <Step name="review" question="this memory will be added to agentcore.json">
        <Summary items={summaryOf(values)} />
      </Step>
    </Wizard>
  );
}
