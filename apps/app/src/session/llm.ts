import { streamText } from "ai";
import { resolveLanguageModel } from "@/provider/index.ts";
import { resolveToolsForAiSdk } from "@/tool/registry.ts";
import { buildSystemPrompt } from "@/agent/prompt.ts";
import { loadConfig } from "@/config/index.ts";
import { getMcpTools } from "@/mcp/index.ts";
import { getAgent } from "@/agent/agent.ts";
import type { CoreMessage } from "ai";

const MAX_AGENT_STEPS = 50;
const DEFAULT_ABORT_TIMEOUT_MILLISECONDS = 300_000;

interface StreamLlmOptions {
  sessionId: string;
  messageId: string;
  agentId: string;
  messages: CoreMessage[];
  abortSignal?: AbortSignal;
  channelType?: string;
  channelChatId?: string;
}

export async function streamLlm(options: StreamLlmOptions) {
  const agentDefinition = getAgent(options.agentId);
  const languageModel = resolveLanguageModel(agentDefinition?.model);
  const config = loadConfig();
  const systemPrompt = buildSystemPrompt(options.agentId);
  const builtinTools = resolveToolsForAiSdk({
    sessionId: options.sessionId,
    messageId: options.messageId,
    workingDirectory: process.cwd(),
    abortSignal: options.abortSignal ?? AbortSignal.timeout(DEFAULT_ABORT_TIMEOUT_MILLISECONDS),
    channelType: options.channelType,
    channelChatId: options.channelChatId,
  });

  const mcpTools = await getMcpTools();
  const mergedTools = { ...builtinTools, ...mcpTools };

  const allTools = agentDefinition?.toolFilter
    ? Object.fromEntries(
        Object.entries(mergedTools).filter(([toolId]) => agentDefinition.toolFilter!(toolId)),
      )
    : mergedTools;

  const maxSteps = agentDefinition?.maxSteps ?? MAX_AGENT_STEPS;

  return streamText({
    model: languageModel,
    system: systemPrompt,
    messages: options.messages,
    tools: allTools,
    maxSteps,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    abortSignal: options.abortSignal,
  });
}
