export const MESSAGE_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
} as const;

export type MessageRole = (typeof MESSAGE_ROLE)[keyof typeof MESSAGE_ROLE];

export interface ToolCallEntry {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ConversationMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallEntry[];
  toolCallId?: string;
  name?: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface CompletionResult {
  id: string;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  toolCalls: ToolCallEntry[];
  finishReason: string;
}

export interface TokenUsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  requestCount: number;
}

export interface StreamDelta {
  content: string;
  done: boolean;
  toolCalls?: ToolCallEntry[];
  finishReason?: string;
}

export type StreamDeltaCallback = (delta: StreamDelta) => void;
