import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  unregister(toolName: string): void {
    this.tools.delete(toolName);
  }

  getTool(toolName: string): Tool | undefined {
    return this.tools.get(toolName);
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  listToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  async executeTool(
    toolName: string,
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        output: "",
        error: `unknown tool: ${toolName}`,
      };
    }

    const validationError = this.validateParameters(tool, parameters);
    if (validationError) {
      return { success: false, output: "", error: validationError };
    }

    try {
      return await tool.execute(parameters, context);
    } catch (executionError) {
      const errorMessage =
        executionError instanceof Error ? executionError.message : String(executionError);
      return { success: false, output: "", error: errorMessage };
    }
  }

  private validateParameters(tool: Tool, parameters: Record<string, unknown>): string | undefined {
    for (const parameterDefinition of tool.definition.parameters) {
      if (parameterDefinition.required && !(parameterDefinition.name in parameters)) {
        return `missing required parameter: ${parameterDefinition.name}`;
      }
    }
    return undefined;
  }
}
