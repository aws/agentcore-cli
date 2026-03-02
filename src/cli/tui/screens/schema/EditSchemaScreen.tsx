import { ConfigIO } from '../../../../lib';
import { AgentCoreMcpSpecSchema, type AgentCoreProjectSpec, AgentCoreProjectSpecSchema } from '../../../../schema';
import { loadSchemaDocument } from '../../../schema';
import { ErrorPrompt, SelectScreen } from '../../components';
import { AgentCoreGuidedEditor } from './AgentCoreGuidedEditor';
import { McpGuidedEditor } from './McpGuidedEditor';
import React, { useCallback, useMemo, useState } from 'react';
import type { ZodType } from 'zod';

interface SchemaOption {
  id: string;
  title: string;
  description: string;
  filePath: string;
  schema: ZodType<unknown>;
}

interface EditSchemaScreenProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
  onRequestAdd?: () => void;
}

export function EditSchemaScreen(props: EditSchemaScreenProps) {
  // isInteractive is available for future use but edit flow is primarily interactive
  const _isInteractive = props.isInteractive;
  const configIO = useMemo(() => new ConfigIO(), []);
  const pathResolver = configIO.getPathResolver();
  const mcpPath = pathResolver.getMcpConfigPath();

  const schemaOptions = useMemo<SchemaOption[]>(() => {
    const projectMissing = configIO.configExists('project') ? '' : ' - missing';
    const mcpMissing = configIO.configExists('mcp') ? '' : ' - missing';

    return [
      {
        id: 'agentcore',
        title: 'agentcore.json',
        description: `AgentCore project config${projectMissing}`,
        filePath: pathResolver.getAgentConfigPath(),
        schema: AgentCoreProjectSpecSchema,
      },
      {
        id: 'mcp',
        title: 'mcp.json',
        description: `Gateways and tools${mcpMissing}`,
        filePath: mcpPath,
        schema: AgentCoreMcpSpecSchema,
      },
    ];
  }, [pathResolver, configIO, mcpPath]);

  const [activeSchema, setActiveSchema] = useState<SchemaOption | null>(null);
  const [errorPrompt, setErrorPrompt] = useState<{ message: string; detail?: string } | null>(null);

  const handleSelectSchema = useCallback((schema: SchemaOption) => {
    if (schema.id !== 'agentcore') {
      setActiveSchema(schema);
      return;
    }

    void (async () => {
      try {
        const result = await loadSchemaDocument(schema.filePath, AgentCoreProjectSpecSchema);
        const parsed = JSON.parse(result.content) as AgentCoreProjectSpec;

        if (!parsed.agents || parsed.agents.length === 0) {
          setErrorPrompt({
            message: 'No agent found in schema.',
            detail: 'agentcore.json must include at least one agent.',
          });
          return;
        }

        setActiveSchema(schema);
      } catch (error) {
        const err = error as Error;
        setErrorPrompt({
          message: 'Unable to open agentcore.json.',
          detail: err.message,
        });
      }
    })();
  }, []);

  if (errorPrompt) {
    return (
      <ErrorPrompt
        message={errorPrompt.message}
        detail={errorPrompt.detail}
        onBack={() => setErrorPrompt(null)}
        onExit={props.onExit}
      />
    );
  }

  if (!activeSchema) {
    return (
      <SelectScreen
        title="Edit Schema"
        items={schemaOptions}
        onSelect={item => handleSelectSchema(item)}
        onExit={props.onExit}
      />
    );
  }

  if (activeSchema.id === 'agentcore') {
    return <AgentCoreGuidedEditor schema={activeSchema} onBack={() => setActiveSchema(null)} />;
  }

  if (activeSchema.id === 'mcp') {
    return (
      <McpGuidedEditor schema={activeSchema} onBack={() => setActiveSchema(null)} onRequestAdd={props.onRequestAdd} />
    );
  }

  return null;
}
