import { eq } from "drizzle-orm";
import type { CoreMessage } from "ai";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDatabase } from "@/storage/db.ts";
import { sessionTable, messageTable, partTable } from "@/storage/schema.ts";
import { Bus, Events } from "@/bus/index.ts";
import { Session } from "@/session/index.ts";
import { streamLlm } from "@/session/llm.ts";
import { generateSessionTitle } from "@/session/title.ts";
import { manageContextWindow, estimateTokens } from "@/session/context.ts";
import { buildSystemPrompt } from "@/agent/prompt.ts";
import { logLlmCall } from "@/audit/index.ts";

interface FilePart {
  path: string;
}

interface ProcessUserMessageOptions {
  sessionId: string;
  agentId: string;
  userPrompt: string;
  fileParts?: FilePart[];
  abortController: AbortController;
}

function buildCoreMessagesFromHistory(sessionId: string): CoreMessage[] {
  const database = getDatabase();

  const messagesWithParts = database
    .select({
      messageId: messageTable.id,
      role: messageTable.role,
      messageTime: messageTable.timeCreated,
      partType: partTable.type,
      partContent: partTable.content,
      partToolName: partTable.toolName,
      partToolCallId: partTable.toolCallId,
      partToolInput: partTable.toolInput,
    })
    .from(messageTable)
    .leftJoin(partTable, eq(partTable.messageId, messageTable.id))
    .where(eq(messageTable.sessionId, sessionId))
    .orderBy(messageTable.timeCreated, partTable.timeCreated)
    .all();

  const coreMessages: CoreMessage[] = [];
  let currentMessageId = "";
  let currentRole = "";
  let userTextParts: string[] = [];
  let assistantContentParts: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  > = [];
  let toolResultParts: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    result: unknown;
  }> = [];

  function flushCurrentMessage() {
    if (!currentMessageId) return;

    if (currentRole === "user") {
      coreMessages.push({ role: "user", content: userTextParts.join("\n") || "" });
    } else if (currentRole === "assistant") {
      if (assistantContentParts.length > 0) {
        coreMessages.push({ role: "assistant", content: assistantContentParts } as CoreMessage);
      }
      if (toolResultParts.length > 0) {
        coreMessages.push({ role: "tool", content: toolResultParts } as CoreMessage);
      }
    }

    userTextParts = [];
    assistantContentParts = [];
    toolResultParts = [];
  }

  for (const row of messagesWithParts) {
    if (row.messageId !== currentMessageId) {
      flushCurrentMessage();
      currentMessageId = row.messageId;
      currentRole = row.role;
    }

    if (!row.partType) continue;

    if (currentRole === "user" && row.partType === "text") {
      userTextParts.push(row.partContent ?? "");
    } else if (currentRole === "assistant") {
      if (row.partType === "text" && row.partContent) {
        assistantContentParts.push({ type: "text", text: row.partContent });
      } else if (row.partType === "tool-call" && row.partToolCallId && row.partToolName) {
        let parsedToolInput: unknown = {};
        try {
          parsedToolInput = row.partToolInput ? JSON.parse(row.partToolInput) : {};
        } catch {
          parsedToolInput = {};
        }
        assistantContentParts.push({
          type: "tool-call",
          toolCallId: row.partToolCallId,
          toolName: row.partToolName,
          args: parsedToolInput,
        });
      } else if (row.partType === "tool-result" && row.partToolCallId && row.partToolName) {
        let parsedResultContent: unknown = row.partContent;
        try {
          parsedResultContent = row.partContent ? JSON.parse(row.partContent) : "";
        } catch {
          parsedResultContent = row.partContent;
        }
        toolResultParts.push({
          type: "tool-result",
          toolCallId: row.partToolCallId,
          toolName: row.partToolName,
          result: parsedResultContent,
        });
      }
    }
  }

  flushCurrentMessage();
  return coreMessages;
}

interface DeferredPartInsert {
  id: string;
  messageId: string;
  sessionId: string;
  type: "text" | "tool-call" | "tool-result" | "reasoning";
  content?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: string;
  state?: "running" | "completed" | "error";
  timeCreated: Date;
}

const TEXT_DELTA_THROTTLE_MILLISECONDS = 16;

export async function processUserMessage(options: ProcessUserMessageOptions): Promise<void> {
  const database = getDatabase();

  const resolvedFileParts = resolveFileReferences(options.userPrompt, options.fileParts ?? []);
  const enrichedPrompt =
    resolvedFileParts.length > 0
      ? buildPromptWithFileContext(options.userPrompt, resolvedFileParts)
      : options.userPrompt;

  Session.addMessage(options.sessionId, "user", options.userPrompt);

  generateSessionTitle(options.sessionId, options.userPrompt);

  let conversationHistory = buildCoreMessagesFromHistory(options.sessionId);

  if (resolvedFileParts.length > 0) {
    const lastUserMessage = conversationHistory[conversationHistory.length - 1];
    if (lastUserMessage?.role === "user") {
      lastUserMessage.content = enrichedPrompt;
    }
  }

  const session = Session.get(options.sessionId);
  const modelContextLength = session?.model
    ? getModelContextLength(session.model)
    : DEFAULT_MODEL_CONTEXT_LENGTH;

  const systemPromptText = buildSystemPrompt(options.agentId);
  const systemPromptTokens = estimateTokens(systemPromptText);

  const contextResult = manageContextWindow(conversationHistory, {
    maxContextTokens: modelContextLength,
    reserveForSystem: systemPromptTokens,
  });

  if (contextResult.wasTruncated) {
    conversationHistory = contextResult.messages;
  }

  const assistantMessage = Session.addMessage(options.sessionId, "assistant");
  const assistantMessageId = assistantMessage.id;

  const streamResult = await streamLlm({
    sessionId: options.sessionId,
    messageId: assistantMessageId,
    agentId: options.agentId,
    messages: conversationHistory,
    abortSignal: options.abortController.signal,
  });

  let accumulatedTextContent = "";
  let currentSegmentText = "";
  let currentSegmentReasoning = "";
  let accumulatedReasoningContent = "";
  let reasoningSegmentId = crypto.randomUUID();
  const deferredPartInserts: DeferredPartInsert[] = [];
  let lastTextPublishTimestamp = 0;
  let lastReasoningPublishTimestamp = 0;
  let insideThinkTag = false;
  let thinkTagChecked = false;
  try {
    for await (const streamEvent of streamResult.fullStream) {
      if (options.abortController.signal.aborted) break;

      if (streamEvent.type === "text-delta") {
        accumulatedTextContent += streamEvent.textDelta;
        currentSegmentText += streamEvent.textDelta;

        if (!thinkTagChecked && currentSegmentText.length >= 7) {
          insideThinkTag = currentSegmentText.startsWith("<think>");
          thinkTagChecked = true;
        }

        if (insideThinkTag) {
          const closeIdx = currentSegmentText.indexOf("</think>");
          if (closeIdx >= 0) {
            const thinkContent = currentSegmentText.slice(7, closeIdx);
            const afterThink = currentSegmentText.slice(closeIdx + 8);

            if (thinkContent !== currentSegmentReasoning) {
              currentSegmentReasoning = thinkContent;
              Bus.publish(Events.Part.Updated, {
                sessionId: options.sessionId,
                messageId: assistantMessageId,
                type: "reasoning",
                segmentId: reasoningSegmentId,
                content: currentSegmentReasoning.trim(),
              });
            }

            accumulatedReasoningContent +=
              (accumulatedReasoningContent ? "\n" : "") + currentSegmentReasoning;
            currentSegmentText = afterThink;
            insideThinkTag = false;
            thinkTagChecked = false;

            if (afterThink) {
              const currentTimestamp = Date.now();
              if (currentTimestamp - lastTextPublishTimestamp >= TEXT_DELTA_THROTTLE_MILLISECONDS) {
                lastTextPublishTimestamp = currentTimestamp;
                Bus.publish(Events.Part.Updated, {
                  sessionId: options.sessionId,
                  messageId: assistantMessageId,
                  type: "text",
                  content: currentSegmentText.trim(),
                });
              }
            }
          } else {
            const thinkContent = currentSegmentText.slice(7);
            if (thinkContent !== currentSegmentReasoning) {
              currentSegmentReasoning = thinkContent;
              Bus.publish(Events.Part.Updated, {
                sessionId: options.sessionId,
                messageId: assistantMessageId,
                type: "reasoning",
                segmentId: reasoningSegmentId,
                content: currentSegmentReasoning.trim(),
              });
            }
          }
        } else if (thinkTagChecked) {
          const currentTimestamp = Date.now();
          if (currentTimestamp - lastTextPublishTimestamp >= TEXT_DELTA_THROTTLE_MILLISECONDS) {
            lastTextPublishTimestamp = currentTimestamp;
            Bus.publish(Events.Part.Updated, {
              sessionId: options.sessionId,
              messageId: assistantMessageId,
              type: "text",
              content: currentSegmentText,
            });
          }
        }
      } else if (streamEvent.type === "tool-call") {
        currentSegmentText = "";
        currentSegmentReasoning = "";
        insideThinkTag = false;
        thinkTagChecked = false;
        reasoningSegmentId = crypto.randomUUID();
        const toolCallPartId = crypto.randomUUID();
        const serializedArgs = JSON.stringify(streamEvent.args);
        deferredPartInserts.push({
          id: toolCallPartId,
          messageId: assistantMessageId,
          sessionId: options.sessionId,
          type: "tool-call",
          toolName: streamEvent.toolName,
          toolCallId: streamEvent.toolCallId,
          toolInput: serializedArgs,
          state: "running",
          timeCreated: new Date(),
        });

        Bus.publish(Events.Part.Created, {
          sessionId: options.sessionId,
          messageId: assistantMessageId,
          partId: toolCallPartId,
          type: "tool-call",
          toolName: streamEvent.toolName,
          toolCallId: streamEvent.toolCallId,
          toolInput: serializedArgs,
        });
      } else if ("toolCallId" in streamEvent && "result" in streamEvent) {
        const toolResultEvent = streamEvent as {
          type: string;
          toolCallId: string;
          toolName: string;
          result: unknown;
        };
        const toolResultPartId = crypto.randomUUID();
        const serializedToolResult =
          typeof toolResultEvent.result === "string"
            ? toolResultEvent.result
            : JSON.stringify(toolResultEvent.result);

        deferredPartInserts.push({
          id: toolResultPartId,
          messageId: assistantMessageId,
          sessionId: options.sessionId,
          type: "tool-result",
          content: serializedToolResult,
          toolName: toolResultEvent.toolName,
          toolCallId: toolResultEvent.toolCallId,
          state: "completed",
          timeCreated: new Date(),
        });

        Bus.publish(Events.Part.Created, {
          sessionId: options.sessionId,
          messageId: assistantMessageId,
          partId: toolResultPartId,
          type: "tool-result",
          toolName: toolResultEvent.toolName,
          toolCallId: toolResultEvent.toolCallId,
        });
      } else if (streamEvent.type === "reasoning") {
        currentSegmentReasoning += streamEvent.textDelta;
        const currentTimestamp = Date.now();
        if (currentTimestamp - lastReasoningPublishTimestamp >= TEXT_DELTA_THROTTLE_MILLISECONDS) {
          lastReasoningPublishTimestamp = currentTimestamp;
          Bus.publish(Events.Part.Updated, {
            sessionId: options.sessionId,
            messageId: assistantMessageId,
            type: "reasoning",
            segmentId: reasoningSegmentId,
            content: currentSegmentReasoning,
          });
        }
      } else if (streamEvent.type === "error") {
        const errorContent = String(streamEvent.error);
        Bus.publish(Events.Part.Updated, {
          sessionId: options.sessionId,
          messageId: assistantMessageId,
          type: "error",
          content: errorContent,
        });
        deferredPartInserts.push({
          id: crypto.randomUUID(),
          messageId: assistantMessageId,
          sessionId: options.sessionId,
          type: "text",
          content: `[error] ${errorContent}`,
          timeCreated: new Date(),
        });
      }
    }
  } catch (streamIterationError) {
    const errorContent = String(streamIterationError);
    Bus.publish(Events.Part.Updated, {
      sessionId: options.sessionId,
      messageId: assistantMessageId,
      type: "error",
      content: errorContent,
    });
    deferredPartInserts.push({
      id: crypto.randomUUID(),
      messageId: assistantMessageId,
      sessionId: options.sessionId,
      type: "text",
      content: `[error] ${errorContent}`,
      timeCreated: new Date(),
    });
  }

  const wasAborted = options.abortController.signal.aborted;

  const fullReasoningContent =
    accumulatedReasoningContent +
    (currentSegmentReasoning
      ? (accumulatedReasoningContent ? "\n" : "") + currentSegmentReasoning
      : "");

  const finalTextContent = accumulatedTextContent
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .trim();

  Bus.publish(Events.Part.Updated, {
    sessionId: options.sessionId,
    messageId: assistantMessageId,
    type: "stream-complete",
    content: finalTextContent,
    reasoning: fullReasoningContent.trim() || undefined,
  });

  if (!wasAborted) {
    try {
      const resolvedUsage = await streamResult.usage;
      Bus.publish(Events.Usage.Updated, {
        sessionId: options.sessionId,
        promptTokens: resolvedUsage.promptTokens,
        completionTokens: resolvedUsage.completionTokens,
        totalTokens: resolvedUsage.totalTokens,
      });

      logLlmCall({
        sessionId: options.sessionId,
        promptTokens: resolvedUsage.promptTokens,
        completionTokens: resolvedUsage.completionTokens,
        totalTokens: resolvedUsage.totalTokens,
      });
    } catch {}
  }

  if (finalTextContent) {
    deferredPartInserts.push({
      id: crypto.randomUUID(),
      messageId: assistantMessageId,
      sessionId: options.sessionId,
      type: "text",
      content: finalTextContent,
      timeCreated: new Date(),
    });
  }

  if (!wasAborted && deferredPartInserts.length > 0) {
    const rawDb = database.$client;
    const insertTransaction = rawDb.transaction(() => {
      database.insert(partTable).values(deferredPartInserts).run();
      database
        .update(sessionTable)
        .set({ timeUpdated: new Date() })
        .where(eq(sessionTable.id, options.sessionId))
        .run();
    });
    insertTransaction();
  }

  Bus.publish(Events.Session.Updated, { sessionId: options.sessionId });
}

const FILE_REFERENCE_PATTERN = /(?<!\w)@(\.?[^\s,`]+(?:\.[^\s,`]+)*)/g;
const MAX_FILE_CONTENT_LENGTH = 50_000;

interface ResolvedFile {
  path: string;
  content: string;
}

function resolveFileReferences(prompt: string, explicitParts: FilePart[]): ResolvedFile[] {
  const referencedPaths = new Set<string>();

  for (const part of explicitParts) {
    referencedPaths.add(part.path);
  }

  for (const match of prompt.matchAll(FILE_REFERENCE_PATTERN)) {
    const rawPath = match[1];
    if (rawPath) referencedPaths.add(rawPath);
  }

  const resolved: ResolvedFile[] = [];
  const workingDirectory = process.cwd();

  for (const filePath of referencedPaths) {
    const absolutePath = resolve(workingDirectory, filePath);
    if (!existsSync(absolutePath)) continue;

    try {
      let content = readFileSync(absolutePath, "utf-8");
      if (content.length > MAX_FILE_CONTENT_LENGTH) {
        content = content.slice(0, MAX_FILE_CONTENT_LENGTH) + "\n... (truncated)";
      }
      resolved.push({ path: filePath, content });
    } catch {
      continue;
    }
  }

  return resolved;
}

function buildPromptWithFileContext(originalPrompt: string, files: ResolvedFile[]): string {
  const fileContextBlocks = files
    .map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
    .join("\n\n");

  return `${fileContextBlocks}\n\n${originalPrompt}`;
}

const DEFAULT_MODEL_CONTEXT_LENGTH = 200_000;

const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
  "anthropic/claude-sonnet-4-20250514": 200_000,
  "anthropic/claude-opus-4-20250514": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  o1: 200_000,
  "o1-mini": 128_000,
  "o3-mini": 200_000,
  "moonshotai/kimi-k2.5": 262_144,
};

function getModelContextLength(modelId: string): number {
  if (MODEL_CONTEXT_LENGTHS[modelId]) return MODEL_CONTEXT_LENGTHS[modelId];

  for (const [knownId, contextLength] of Object.entries(MODEL_CONTEXT_LENGTHS)) {
    if (modelId.includes(knownId) || knownId.includes(modelId)) return contextLength;
  }

  return DEFAULT_MODEL_CONTEXT_LENGTH;
}
