import { PROJECT_TEMPLATES, type ProjectTemplate } from "../../handlers/project/types";

type TemplateSpec = {
  runtimes?: unknown[];
  memories?: unknown[];
  harnesses?: unknown[];
};

/**
 * A project template pairs the agent code scaffolded under app/ with the resource
 * sections it registers in agentcore.json. Adding a template is one entry here plus its assets.
 */
type Template = {
  /** Directory under app/ the template code is written to. */
  appDir: string;
  /** Asset directory relative to the asset root, expanded into the app directory. */
  assetDir: string;
  /** Resource sections this template contributes to agentcore.json. */
  spec: TemplateSpec;
};

export const TEMPLATES: Record<ProjectTemplate, Template> = {
  [PROJECT_TEMPLATES.HELLO_WORLD_PYTHON]: {
    appDir: "hello-world",
    assetDir: "templates/hello-world-python",
    spec: {
      runtimes: [
        {
          name: "hello_world",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/hello-world",
        },
      ],
    },
  },
};
