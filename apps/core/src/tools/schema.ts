export interface ToolParameterDefinition {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterDefinition[];
  requiresConfirmation?: boolean;
}

export interface ToolExecutionContext {
  workingDirectory: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(parameters: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

export function formatToolDefinitionsForPrompt(tools: Tool[]): string {
  return tools
    .map((tool) => {
      const parametersDescription = tool.definition.parameters
        .map((parameter) => {
          const requiredLabel = parameter.required ? "required" : "optional";
          return `    - ${parameter.name} (${parameter.type}, ${requiredLabel}): ${parameter.description}`;
        })
        .join("\n");

      return `- ${tool.definition.name}: ${tool.definition.description}\n  parameters:\n${parametersDescription}`;
    })
    .join("\n\n");
}

export interface NativeToolParameter {
  type: string;
  description: string;
}

export interface NativeTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, NativeToolParameter>;
      required: string[];
    };
  };
}

export function toolsToNativeFormat(tools: Tool[]): NativeTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.definition.name,
      description: tool.definition.description,
      parameters: {
        type: "object" as const,
        properties: Object.fromEntries(
          tool.definition.parameters.map((p) => [
            p.name,
            {
              type: p.type,
              description: p.description,
            },
          ]),
        ),
        required: tool.definition.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }));
}
