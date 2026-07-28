import { PROJECT_TEMPLATES, type ProjectTemplate } from "../handlers/project/types";

interface TemplateSpec {
  runtimes?: unknown[];
  memories?: unknown[];
  harnesses?: unknown[];
}

/**
 * A project template: the agent code it scaffolds under `app/` and the resource
 * sections it registers in `agentcore.json`. Adding a template is one entry here
 * plus its assets under `src/assets/<assetDir>`
 */
interface Template {
  /** Directory under `app/` the template's code is written to. */
  appDir: string;
  /** Asset directory (relative to the asset root) expanded into `app/<appDir>`. */
  assetDir: string;
  /** Resource sections this template contributes to `agentcore.json`. */
  spec: TemplateSpec;
}

export const TEMPLATES: Record<ProjectTemplate, Template> = {
  [PROJECT_TEMPLATES.HELLO_WORLD_PYTHON]: {
    appDir: "hello-world",
    assetDir: "templates/hello-world-python",
    spec: {
      runtimes: [
        {
          name: "hello-world",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/hello-world",
        },
      ],
    },
  },
};
