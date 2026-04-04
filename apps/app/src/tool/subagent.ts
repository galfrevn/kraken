import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { getSubAgents, getAgent } from "@/agent/agent.ts";
import { Session } from "@/session/index.ts";
import { streamLlm } from "@/session/llm.ts";
import { Bus, Events } from "@/bus/index.ts";
import type { CoreMessage } from "ai";

const DEFAULT_SUBAGENT_TIMEOUT_MS = 180_000;

const subagentIds = () => getSubAgents().map((a) => a.id);

export const subagentTool = defineTool({
  id: "subagent",
  description: `Delegate a task to a specialized sub-agent that runs in its own session. Available sub-agents: explore (fast, read-only codebase exploration), general (full-access multi-step tasks). Each sub-agent may use a different model optimized for its role. Use this when a task can be handled independently without requiring conversation context.`,
  parameters: z.object({
    agent: z
      .string()
      .describe(
        "The sub-agent ID to delegate to. Use 'explore' for read-only searches and 'general' for multi-step tasks.",
      ),
    prompt: z
      .string()
      .describe(
        "Clear, self-contained instructions for the sub-agent. Include all necessary context — the sub-agent has no access to the parent conversation.",
      ),
  }),
  async execute(args, context) {
    const agentDefinition = getAgent(args.agent);
    if (!agentDefinition || agentDefinition.mode !== "subagent") {
      const available = subagentIds().join(", ");
      return {
        title: "subagent error",
        content: `Unknown sub-agent '${args.agent}'. Available: ${available}`,
      };
    }

    const childSession = Session.create({
      agentId: args.agent,
      parentId: context.sessionId,
      title: `[${agentDefinition.name}] ${args.prompt.slice(0, 60)}`,
    });

    Session.addMessage(childSession.id, "user", args.prompt);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), DEFAULT_SUBAGENT_TIMEOUT_MS);

    const childMessageRecord = Session.addMessage(childSession.id, "assistant");

    Bus.publish(Events.Part.Updated, {
      sessionId: context.sessionId,
      messageId: context.messageId,
      type: "text",
      content: `⟳ Delegating to ${agentDefinition.name} agent...`,
    });

    try {
      const messages: CoreMessage[] = [{ role: "user", content: args.prompt }];

      const streamResult = await streamLlm({
        sessionId: childSession.id,
        messageId: childMessageRecord.id,
        agentId: args.agent,
        messages,
        abortSignal: abortController.signal,
      });

      let fullText = "";
      for await (const event of streamResult.fullStream) {
        if (abortController.signal.aborted) break;
        if (event.type === "text-delta") {
          fullText += event.textDelta;
        }
      }

      fullText = fullText.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

      clearTimeout(timeout);

      return {
        title: `${agentDefinition.name}: ${args.prompt.slice(0, 50)}`,
        content: `<!--session:${childSession.id}-->\n${fullText || "(sub-agent returned no output)"}`,
        metadata: { childSessionId: childSession.id, agent: args.agent },
      };
    } catch (error) {
      clearTimeout(timeout);
      const errorMessage = abortController.signal.aborted
        ? "Sub-agent timed out after 3 minutes"
        : String(error);
      return {
        title: `${agentDefinition.name}: error`,
        content: `Sub-agent failed: ${errorMessage}`,
        metadata: { childSessionId: childSession.id, agent: args.agent, error: true },
      };
    }
  },
});
