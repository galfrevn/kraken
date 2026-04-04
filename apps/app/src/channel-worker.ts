import { Hono } from "hono";
import { initializeBuiltinTools } from "@/tool/registry.ts";
import { initializeAgents, applyAgentConfigOverrides } from "@/agent/agent.ts";
import { initializeMcpServers } from "@/mcp/index.ts";
import { loadConfig, resetConfig } from "@/config/index.ts";
import { streamLlm } from "@/session/llm.ts";
import { buildSystemPrompt } from "@/agent/prompt.ts";
import type { CoreMessage } from "ai";

const WORKER_ABORT_TIMEOUT_MS = 600_000;
const DEFAULT_PORT = 7900;

function parseCliArgument(prefix: string): string | undefined {
  const matchingArg = process.argv.find((arg) => arg.startsWith(prefix));
  return matchingArg?.slice(prefix.length);
}

interface MessageHistory {
  messages: CoreMessage[];
  channelType?: string;
  chatId?: string;
}

const sessionMessages = new Map<string, MessageHistory>();

function buildChannelSystemPrompt(agentId: string): string {
  const basePrompt = buildSystemPrompt(agentId);
  const currentConfig = loadConfig();
  const activeModel = `${currentConfig.provider}/${currentConfig.model}`;

  const nowUtc = new Date().toISOString();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const localTime = new Date().toLocaleString("en-US", { timeZone: tz });

  return `${basePrompt}

# Channel Mode
You are responding through a messaging channel (Telegram, Discord, etc.).
Model: ${activeModel}
Time: ${localTime} (${tz}), UTC: ${nowUtc}

Channel-specific rules:
- Be concise. Messages should be short and readable on mobile.
- Respond in the same language the user writes in.
- After completing a task, give a brief summary of what you did.
- When using schedule_task run_at, convert to UTC first. Use format "YYYY-MM-DDTHH:MM:SSZ".
- NEVER read, print, or output environment variables, secrets, API keys, or credentials.
- NEVER push directly to main or master branches. Always use feature branches.`;
}

const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 100;

function resolveHistory(sessionId: string): MessageHistory {
  let history = sessionMessages.get(sessionId);
  if (!history) {
    history = {
      messages: [{ role: "system", content: buildChannelSystemPrompt("build") }],
    };
    sessionMessages.set(sessionId, history);

    // Evict oldest sessions if over limit
    if (sessionMessages.size > MAX_SESSIONS) {
      const oldest = sessionMessages.keys().next().value;
      if (oldest) sessionMessages.delete(oldest);
    }
  }

  // Trim old messages (keep system prompt + last N messages)
  if (history.messages.length > MAX_MESSAGES_PER_SESSION) {
    const system = history.messages[0]!;
    history.messages = [system, ...history.messages.slice(-(MAX_MESSAGES_PER_SESSION - 1))];
  }
  return history;
}

const TOOL_CALL_XML_PATTERN = /<[a-zA-Z_:]+:tool_call[\s\S]*?<\/[a-zA-Z_:]+:tool_call>/g;
const GENERIC_XML_TOOL_PATTERN = /<tool_call[\s\S]*?<\/tool_call>/g;
const FUNCTION_CALL_PATTERN = /<function_call[\s\S]*?<\/function_call>/g;

function stripToolCallXml(text: string): string {
  return text
    .replace(TOOL_CALL_XML_PATTERN, "")
    .replace(GENERIC_XML_TOOL_PATTERN, "")
    .replace(FUNCTION_CALL_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function main(): Promise<void> {
  const port = parseInt(parseCliArgument("--port=") ?? String(DEFAULT_PORT), 10);

  initializeBuiltinTools();
  initializeAgents();
  await initializeMcpServers();

  const config = loadConfig();
  if (Object.keys(config.agents).length > 0) {
    applyAgentConfigOverrides(config.agents);
  }

  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/message", async (c) => {
    const body = await c.req.json<{
      sessionId: string;
      text: string;
      channelType?: string;
      chatId?: string;
      agentId?: string;
    }>();

    if (!body.sessionId || !body.text) {
      return c.json({ error: "sessionId and text are required" }, 400);
    }

    // Re-read config + modelstate.json so model changes from TUI are picked up
    resetConfig();
    const freshConfig = loadConfig();
    console.error(`[channel-worker] resolved model: ${freshConfig.provider}/${freshConfig.model}`);
    if (Object.keys(freshConfig.agents).length > 0) {
      applyAgentConfigOverrides(freshConfig.agents);
    }

    const history = resolveHistory(body.sessionId);
    if (body.channelType) history.channelType = body.channelType;
    if (body.chatId) history.chatId = body.chatId;
    const agentId = body.agentId || "build";
    history.messages[0] = { role: "system", content: buildChannelSystemPrompt(agentId) };
    history.messages.push({ role: "user", content: body.text });

    const abortController = new AbortController();
    const abortTimeout = setTimeout(() => abortController.abort(), WORKER_ABORT_TIMEOUT_MS);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const writeEvent = (data: object) =>
      writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

    (async () => {
      try {
        const streamResult = await streamLlm({
          sessionId: body.sessionId,
          messageId: crypto.randomUUID(),
          agentId,
          messages: history.messages,
          channelType: history.channelType,
          channelChatId: history.chatId,
          abortSignal: abortController.signal,
        });

        let fullText = "";

        for await (const event of streamResult.fullStream) {
          if (abortController.signal.aborted) break;

          if (event.type === "text-delta") {
            fullText += event.textDelta;
            await writeEvent({ type: "delta", text: event.textDelta });
          } else if (event.type === "tool-call") {
            await writeEvent({ type: "typing", text: event.toolName });
          } else if (event.type === "step-start" || event.type === "step-finish") {
            await writeEvent({ type: "typing", text: "" });
          }
        }

        const cleanText = stripToolCallXml(fullText);
        await writeEvent({ type: "done", text: cleanText });
        history.messages.push({ role: "assistant", content: cleanText });
      } catch (error) {
        await writeEvent({ type: "error", text: String(error) });
      } finally {
        clearTimeout(abortTimeout);
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  });

  Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 255,
  });

  console.log(`[channel-worker] listening on port ${port}`);
}

main().catch((error) => {
  console.error(`[channel-worker] fatal: ${error}`);
  process.exit(1);
});
