import { Hono } from "hono";
import { initializeBuiltinTools } from "@/tool/registry.ts";
import { initializeAgents, applyAgentConfigOverrides } from "@/agent/agent.ts";
import { initializeMcpServers } from "@/mcp/index.ts";
import { loadConfig } from "@/config/index.ts";
import { streamLlm } from "@/session/llm.ts";
import type { CoreMessage } from "ai";

const WORKER_ABORT_TIMEOUT_MS = 600_000;
const DEFAULT_PORT = 7900;

function parseCliArgument(prefix: string): string | undefined {
  const matchingArg = process.argv.find((arg) => arg.startsWith(prefix));
  return matchingArg?.slice(prefix.length);
}

interface MessageHistory {
  messages: CoreMessage[];
}

const sessionMessages = new Map<string, MessageHistory>();

function buildChannelSystemPrompt(): string {
  const nowUtc = new Date().toISOString();
  const localOffset = -new Date().getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(localOffset) / 60);
  const offsetMinutes = Math.abs(localOffset) % 60;
  const offsetSign = localOffset >= 0 ? "+" : "-";
  const tz =
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    `UTC${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;
  const localTime = new Date().toLocaleString("en-US", { timeZone: tz });

  return `You are Kraken, an autonomous AI development agent responding through Telegram.

You have full access to all tools: read/write/edit files, run bash commands, search code, web search, and more. You ARE properly configured and running — the user is talking to you through a working Telegram channel right now.

Current time:
- UTC now: ${nowUtc}
- User's local time (${tz}): ${localTime}
- UTC offset: ${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}
- CRITICAL: When using schedule_task run_at, you MUST convert to UTC first. Example: if user says "in 5 minutes" and UTC is ${nowUtc}, compute UTC + 5min. Always use format "YYYY-MM-DDTHH:MM:SSZ" with the Z suffix (UTC).

Key info:
- Kraken config: ~/.kraken/kraken.jsonc (JSONC format)
- Secrets: ~/.kraken/.env (referenced with \${VAR_NAME} in config)
- Triggers (crons, webhooks, watchers) are defined in kraken.jsonc under the "triggers" key
- The daemon is running and you can modify its configuration

Rules:
- Be concise. Messages should be short and readable on mobile.
- Respond in the same language the user writes in.
- After completing a task, give a brief summary of what you did.`;
}

function resolveHistory(sessionId: string): MessageHistory {
  let history = sessionMessages.get(sessionId);
  if (!history) {
    history = {
      messages: [{ role: "system", content: buildChannelSystemPrompt() }],
    };
    sessionMessages.set(sessionId, history);
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
    const body = await c.req.json<{ sessionId: string; text: string }>();

    if (!body.sessionId || !body.text) {
      return c.json({ error: "sessionId and text are required" }, 400);
    }

    const history = resolveHistory(body.sessionId);
    history.messages[0] = { role: "system", content: buildChannelSystemPrompt() };
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
          agentId: "build",
          messages: history.messages,
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
