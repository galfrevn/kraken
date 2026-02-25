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
