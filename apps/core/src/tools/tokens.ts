import type { Tool, ToolResult } from "@/tools/schema.ts";

const AVERAGE_CHARACTERS_PER_TOKEN = 4;
const MAX_INPUT_LENGTH = 500_000;

export const countTokensTool: Tool = {
  definition: {
    name: "count_tokens",
    description: "Estimate token count in a text string (~4 chars/token).",
    parameters: [
      { name: "text", type: "string", description: "The text to count tokens for", required: true },
    ],
  },

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const text = parameters["text"] as string;

    if (!text) {
      return { success: true, output: "0 tokens (empty input)" };
    }

    if (text.length > MAX_INPUT_LENGTH) {
      return {
        success: false,
        output: "",
        error: `input too long (${text.length} chars, max ${MAX_INPUT_LENGTH})`,
      };
    }

    const characters = text.length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text.split(/\r?\n/).length;
    const estimatedTokens = Math.ceil(characters / AVERAGE_CHARACTERS_PER_TOKEN);

    const breakdown = [
      `estimated tokens: ~${estimatedTokens.toLocaleString()}`,
      `characters: ${characters.toLocaleString()}`,
      `words: ${words.toLocaleString()}`,
      `lines: ${lines.toLocaleString()}`,
      ``,
      `note: this is an approximation (~4 chars/token). actual count varies by model and content.`,
    ];

    return { success: true, output: breakdown.join("\n") };
  },
};
