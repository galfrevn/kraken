export const MESSAGE_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
} as const;

export type MessageRole = (typeof MESSAGE_ROLE)[keyof typeof MESSAGE_ROLE];

export interface ConversationMessage {
  role: MessageRole;
  content: string;
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
}

export interface TokenUsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  requestCount: number;
}

export interface StreamDelta {
  content: string;
  done: boolean;
}

export type StreamDeltaCallback = (delta: StreamDelta) => void;
