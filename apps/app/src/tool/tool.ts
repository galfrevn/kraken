import type { z } from "zod";

export interface ToolResult {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  sessionId: string;
  messageId: string;
  workingDirectory: string;
  abortSignal: AbortSignal;
  channelType?: string;
  channelChatId?: string;
}

export interface ToolDefinition<TParameters extends z.ZodType = z.ZodType> {
  id: string;
  description: string;
  parameters: TParameters;
  execute(args: z.infer<TParameters>, context: ToolContext): Promise<ToolResult>;
}

export function defineTool<TParameters extends z.ZodType>(
  definition: ToolDefinition<TParameters>,
): ToolDefinition<TParameters> {
  return definition;
}
