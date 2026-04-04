import { useState, useEffect, useRef, useCallback } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useDialog } from "@opentui-ui/dialog/react";
import type { ModelSelection } from "@/models/types.ts";
import { ModelPickerContent } from "@/tui/session/_components/model.tsx";
import { useRoute } from "@/tui/_context/route.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useCommands } from "@/tui/_context/commands.tsx";
import { useModels } from "@/tui/_context/models.tsx";
import { SessionLayout } from "@/tui/session/_components/layout.tsx";
import { SessionPrompt } from "@/tui/session/_components/prompt.tsx";
import {
  UserMessage,
  AssistantMessage,
  AssistantMetadata,
  ReasoningMessage,
} from "@/tui/session/_components/message.tsx";
import { ToolCallDisplay } from "@/tui/session/_components/tool.tsx";
import { ThemePickerContent } from "@/tui/session/_components/theme.tsx";
import { SessionPickerContent } from "@/tui/session/_components/session-picker.tsx";
import { QuestionPrompt } from "@/tui/session/_components/question.tsx";
import { EmptyState } from "@/tui/session/_components/empty-state.tsx";
import { PermissionPrompt } from "@/tui/session/_components/permission.tsx";
import type { PermissionRequest } from "@/tool/permission.ts";
import { addAllowRule } from "@/tool/permission-allowlist.ts";
import type { FileChange } from "@/tui/session/_components/files-sidebar.tsx";
import { getSkillSlashCommands, loadSkillByName, formatSkillContent } from "@/skill/index.ts";
import { getPrimaryAgents, type AgentColor } from "@/agent/agent.ts";
import type { ThemeColors } from "@/tui/_context/theme.tsx";

type StreamingPart =
  | { kind: "reasoning"; id: string; content: string }
  | { kind: "text"; id: string; content: string }
  | {
      kind: "tool-call";
      id: string;
      toolName: string;
      toolCallId: string;
      toolInput?: string;
      state: "running" | "completed" | "error";
      resultContent?: string;
      liveOutput?: string;
    };

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  parts?: StreamingPart[];
  modelId?: string;
  agentName?: string;
  agentColorKey?: AgentColor;
  startedAt?: number;
  completedAt?: number;
}

function findLastIndex<T>(array: T[], predicate: (item: T) => boolean): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i]!)) return i;
  }
  return -1;
}

function resolveAgentColor(colorKey: AgentColor | undefined, themeColors: ThemeColors): string {
  if (!colorKey) return themeColors.secondary;
  return themeColors[colorKey] ?? themeColors.secondary;
}

const MIN_STREAM_VISIBLE_MS = 2000;
const TOOL_MIN_RUNNING_MS = 400;

export const Session = () => {
  const { theme } = useTheme();
  const route = useRoute();
  const sdk = useSdk();
  const renderer = useRenderer();
  const commands = useCommands();
  const { current: currentModelSelection, selectModel, getModelInfo } = useModels();
  const dialog = useDialog();

  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const openModelPicker = useCallback(async () => {
    setIsDialogOpen(true);
    const selectedModelResult = await dialog.choice<ModelSelection>({
      content: (choiceContext) => <ModelPickerContent {...choiceContext} />,
      size: "large",
    });
    setIsDialogOpen(false);
    if (selectedModelResult) {
      await selectModel(selectedModelResult.modelId, selectedModelResult.providerId);
    }
  }, [dialog, selectModel]);

  const openThemePicker = useCallback(async () => {
    setIsDialogOpen(true);
    await dialog.choice<string>({
      content: (choiceContext) => <ThemePickerContent {...choiceContext} />,
      size: "large",
    });
    setIsDialogOpen(false);
  }, [dialog]);

  const openSessionPicker = useCallback(async () => {
    setIsDialogOpen(true);
    const selectedSession = await dialog.choice<{ id: string }>({
      content: (choiceContext) => (
        <SessionPickerContent {...choiceContext} sdk={sdk} theme={theme} />
      ),
      size: "large",
    });
    setIsDialogOpen(false);
    if (selectedSession) {
      route.goToSession(selectedSession.id);
    }
  }, [dialog, sdk, theme, route]);

  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamingParts, setStreamingParts] = useState<StreamingPart[]>([]);
  const [totalTokenCount, setTotalTokenCount] = useState(0);
  const [totalEstimatedCost, setTotalEstimatedCost] = useState(0);

  const [pendingQuestion, setPendingQuestion] = useState<{
    questions: Array<{
      id: string;
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
  } | null>(null);

  const [sessionTodos, setSessionTodos] = useState<
    Array<{
      id: string;
      content: string;
      status: "pending" | "in_progress" | "completed" | "cancelled";
      priority?: "high" | "medium" | "low";
    }>
  >([]);
  const [modifiedFiles, setModifiedFiles] = useState<FileChange[]>([]);
  const [revertedMessages, setRevertedMessages] = useState<DisplayMessage[]>([]);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  const primaryAgents = getPrimaryAgents();
  const [currentAgentIndex, setCurrentAgentIndex] = useState(0);
  const currentAgent = primaryAgents[currentAgentIndex] ?? primaryAgents[0]!;

  const currentAgentColor = resolveAgentColor(currentAgent.color, theme);

  const handleToggleAgent = useCallback(() => {
    setCurrentAgentIndex((prev) => (prev + 1) % primaryAgents.length);
  }, [primaryAgents.length]);

  const currentSessionId = route.route.type === "session" ? route.route.sessionId : "";
  const initialPromptText = route.route.type === "session" ? route.route.initialPrompt : undefined;
  const sessionStartTimestamp = useRef(Date.now());

  const initialPromptSentRef = useRef(false);
  const streamFirstPartTimeRef = useRef(0);
  const finalizationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolCallTimesRef = useRef<Record<string, number>>({});
  const [sessionTitle, setSessionTitle] = useState(
    `New session — ${new Date(sessionStartTimestamp.current).toISOString()}`,
  );

  useEffect(() => {
    const removeSessionEventHandler = sdk.onEvent((eventType, eventData) => {
      if (eventType === "session.updated") {
        const sessionEvent = eventData as { sessionId?: string };
        if (sessionEvent.sessionId === currentSessionId) {
          sdk.client
            .fetch(`/session/${currentSessionId}`)
            .then(async (response) => {
              if (!response.ok) return;
              const sessionData = (await response.json()) as { title?: string };
              if (sessionData.title) setSessionTitle(sessionData.title);
            })
            .catch(() => {});
        }
      }
    });
    return removeSessionEventHandler;
  }, [currentSessionId, sdk]);

  useEffect(() => {
    const unregisterCommands = commands.register(() => [
      {
        title: "Clear conversation",
        value: "session.clear",
        description: "Clear all messages and start fresh",
        slash: { name: "clear" },
        onSelect: () => {
          sdk.client
            .fetch(`/session/${currentSessionId}/messages`, { method: "DELETE" })
            .catch(() => {});
          setDisplayMessages([]);
          setStreamingParts([]);
          setTotalTokenCount(0);
          setTotalEstimatedCost(0);
        },
      },
      {
        title: "New session",
        value: "session.new",
        description: "Start a new conversation",
        slash: { name: "new" },
        onSelect: () => {
          route.goHome();
        },
      },
      {
        title: "Switch session",
        value: "session.list",
        description: "Resume a previous conversation",
        slash: { name: "sessions", aliases: ["resume", "continue"] },
        onSelect: () => {
          openSessionPicker();
        },
      },
      {
        title: "Go home",
        value: "navigate.home",
        description: "Return to the home screen",
        slash: { name: "home" },
        onSelect: () => {
          route.goHome();
        },
      },
      {
        title: "Exit Kraken",
        value: "app.exit",
        description: "Exit the application",
        slash: { name: "exit", aliases: ["quit"] },
        onSelect: () => {
          renderer.destroy();
          process.exit(0);
        },
      },
      {
        title: "Select model",
        value: "model.select",
        description: "Open the model picker",
        slash: { name: "model" },
        onSelect: () => {
          openModelPicker();
        },
      },
      {
        title: "Switch theme",
        value: "theme.switch",
        description: "Change the color theme",
        slash: { name: "theme", aliases: ["themes"] },
        onSelect: () => {
          openThemePicker();
        },
      },
      ...getSkillSlashCommands().map((sc) => ({
        title: sc.skillName,
        value: `skill.${sc.skillName}`,
        description: sc.description,
        slash: { name: sc.slash.name, aliases: sc.slash.aliases },
        onSelect: () => {
          const skill = loadSkillByName(sc.skillName);
          if (!skill) return;
          const content = formatSkillContent(skill);
          handlePromptSubmit(
            `I've loaded the "${sc.skillName}" skill. Here are the instructions:\n\n${content}\n\nFollow these instructions to help me.`,
          );
        },
      })),
    ]);

    return unregisterCommands;
  }, []);

  const handleUndo = useCallback(() => {
    if (isProcessing || displayMessages.length === 0) return;
    const lastUserIndex = findLastIndex(displayMessages, (m) => m.role === "user");
    if (lastUserIndex === -1) return;
    const removed = displayMessages.slice(lastUserIndex);
    setRevertedMessages((prev) => [...removed, ...prev]);
    setDisplayMessages((prev) => prev.slice(0, lastUserIndex));
  }, [isProcessing, displayMessages]);

  const handleRedo = useCallback(() => {
    if (isProcessing || revertedMessages.length === 0) return;
    const firstUserIndex = revertedMessages.findIndex((m) => m.role === "user");
    if (firstUserIndex === -1) return;
    let nextUserIndex = revertedMessages.findIndex(
      (m, i) => i > firstUserIndex && m.role === "user",
    );
    if (nextUserIndex === -1) nextUserIndex = revertedMessages.length;
    const restored = revertedMessages.slice(0, nextUserIndex);
    setRevertedMessages((prev) => prev.slice(nextUserIndex));
    setDisplayMessages((prev) => [...prev, ...restored]);
  }, [isProcessing, revertedMessages]);

  useKeyboard((keyEvent) => {
    if (keyEvent.ctrl && keyEvent.name === "m") {
      openModelPicker();
    }
    if (keyEvent.ctrl && keyEvent.name === "c") {
      renderer.destroy();
      process.exit(0);
    }
    if (keyEvent.ctrl && keyEvent.name === "z") {
      handleUndo();
    }
    if (keyEvent.ctrl && keyEvent.name === "y") {
      handleRedo();
    }
  });

  useEffect(() => {
    if (!currentSessionId || initialPromptText) return;

    sdk.client
      .fetch(`/session/${currentSessionId}/history`)
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as {
          messages: Array<{
            id: string;
            role: string;
            parts: Array<{
              id: string;
              type: string;
              content: string;
              toolName?: string;
              toolCallId?: string;
              toolInput?: string;
              state?: string;
            }>;
          }>;
        };
        if (!data.messages || data.messages.length === 0) return;

        const hydrated: DisplayMessage[] = [];
        for (const msg of data.messages) {
          if (msg.role === "user") {
            const textContent = msg.parts
              .filter((p) => p.type === "text")
              .map((p) => p.content)
              .join("\n");
            if (textContent) {
              hydrated.push({
                id: msg.id,
                role: "user",
                text: textContent,
              });
            }
          } else if (msg.role === "assistant") {
            const textParts = msg.parts.filter((p) => p.type === "text");
            const reasoningParts = msg.parts.filter((p) => p.type === "reasoning");
            const toolCallParts = msg.parts.filter((p) => p.type === "tool-call");
            const toolResultParts = msg.parts.filter((p) => p.type === "tool-result");

            const assistantText = textParts.map((p) => p.content).join("\n");

            const parts: StreamingPart[] = [];
            for (const r of reasoningParts) {
              parts.push({ kind: "reasoning", id: r.id, content: r.content });
            }
            for (const tc of toolCallParts) {
              const matchingResult = toolResultParts.find((tr) => tr.toolCallId === tc.toolCallId);
              parts.push({
                kind: "tool-call",
                id: tc.id,
                toolName: tc.toolName ?? "unknown",
                toolCallId: tc.toolCallId ?? "",
                toolInput: tc.toolInput,
                state: "completed",
                resultContent: matchingResult?.content,
              });
            }

            hydrated.push({
              id: msg.id,
              role: "assistant",
              text: assistantText,
              parts: parts.length > 0 ? parts : undefined,
            });
          }
        }

        if (hydrated.length > 0) {
          setDisplayMessages(hydrated);
          const sessionData = await sdk.client
            .fetch(`/session/${currentSessionId}`)
            .then((r) => r.json() as Promise<{ title?: string }>)
            .catch(() => null);
          if (sessionData?.title) setSessionTitle(sessionData.title);
        }
      })
      .catch(() => {});
  }, [currentSessionId]);

  useEffect(() => {
    if (initialPromptText && !initialPromptSentRef.current) {
      initialPromptSentRef.current = true;
      setDisplayMessages([
        {
          id: crypto.randomUUID(),
          role: "user",
          text: initialPromptText,
          startedAt: Date.now(),
        },
      ]);
      setIsProcessing(true);
      sdk.client
        .post(`/session/${currentSessionId}/message`, {
          content: initialPromptText,
        })
        .then((response) => {
          if (!response.ok) setIsProcessing(false);
        })
        .catch(() => {
          setIsProcessing(false);
        });
    }
  }, [initialPromptText, currentSessionId]);

  useEffect(() => {
    const removeEventHandler = sdk.onEvent((eventType: string, eventData: unknown) => {
      const eventRecord = eventData as Record<string, unknown>;
      if ((eventRecord as { sessionId?: string }).sessionId !== currentSessionId) return;

      if (eventType === "message.created") {
        if (eventRecord.role === "user") {
          const messageContent = (eventRecord.content as string) ?? "";
          if (!messageContent) return;
          setDisplayMessages((previousMessages) => {
            const alreadyDisplayed = previousMessages.some(
              (existingMessage) =>
                existingMessage.role === "user" && existingMessage.text === messageContent,
            );
            if (alreadyDisplayed) return previousMessages;
            return [
              ...previousMessages,
              {
                id: eventRecord.id as string,
                role: "user",
                text: messageContent,
                startedAt: Date.now(),
              },
            ];
          });
          setIsProcessing(true);
          setStreamingParts([]);
          streamFirstPartTimeRef.current = 0;
          toolCallTimesRef.current = {};
          if (finalizationTimerRef.current) {
            clearTimeout(finalizationTimerRef.current);
            finalizationTimerRef.current = null;
          }
        }
      }

      if (eventType === "part.updated" && eventRecord.type === "text") {
        const content = (eventRecord.content as string) ?? "";
        if (streamFirstPartTimeRef.current === 0) streamFirstPartTimeRef.current = Date.now();
        setStreamingParts((prev) => {
          const lastTextIdx = findLastIndex(prev, (p) => p.kind === "text");
          const lastToolIdx = findLastIndex(prev, (p) => p.kind === "tool-call");

          if (lastTextIdx >= 0 && lastTextIdx > lastToolIdx) {
            return prev.map((p, i) =>
              i === lastTextIdx && p.kind === "text" ? { ...p, content } : p,
            );
          }
          return [...prev, { kind: "text" as const, id: crypto.randomUUID(), content }];
        });
      }

      if (eventType === "part.updated" && eventRecord.type === "reasoning") {
        const content = (eventRecord.content as string) ?? "";
        const segmentId = (eventRecord.segmentId as string) ?? "default";
        if (streamFirstPartTimeRef.current === 0) streamFirstPartTimeRef.current = Date.now();
        setStreamingParts((prev) => {
          const idx = prev.findIndex((p) => p.kind === "reasoning" && p.id === segmentId);
          if (idx >= 0) {
            return prev.map((p, i) =>
              i === idx && p.kind === "reasoning" ? { ...p, content } : p,
            );
          }
          return [...prev, { kind: "reasoning" as const, id: segmentId, content }];
        });
      }

      if (eventType === "part.created" && eventRecord.type === "tool-call") {
        const toolCallId = (eventRecord.toolCallId as string) ?? crypto.randomUUID();
        if (streamFirstPartTimeRef.current === 0) streamFirstPartTimeRef.current = Date.now();
        toolCallTimesRef.current[toolCallId] = Date.now();
        setStreamingParts((prev) => [
          ...prev,
          {
            kind: "tool-call" as const,
            id: crypto.randomUUID(),
            toolName: (eventRecord.toolName as string) ?? "unknown",
            toolCallId,
            toolInput: (eventRecord.toolInput as string) ?? undefined,
            state: "running" as const,
          },
        ]);
      }

      if (eventType === "part.created" && eventRecord.type === "tool-result") {
        const toolCallId = (eventRecord.toolCallId as string) ?? "";
        const resultContent = (eventRecord.content as string) ?? "";

        const matchingTool = streamingParts.find(
          (p) => p.kind === "tool-call" && p.toolCallId === toolCallId,
        );
        if (
          matchingTool &&
          matchingTool.kind === "tool-call" &&
          (matchingTool.toolName === "edit" || matchingTool.toolName === "write")
        ) {
          try {
            const args = JSON.parse(matchingTool.toolInput ?? "{}") as { filePath?: string };
            if (args.filePath) {
              const diffMatch = resultContent.match(/<!--diff:\w*-->\n([\s\S]*?)\n<!--\/diff-->/);
              let additions = 0;
              let deletions = 0;
              if (diffMatch?.[1]) {
                for (const line of diffMatch[1].split("\n")) {
                  if (line.startsWith("+") && !line.startsWith("+++")) additions++;
                  if (line.startsWith("-") && !line.startsWith("---")) deletions++;
                }
              }
              setModifiedFiles((prev) => {
                const existing = prev.find((f) => f.path === args.filePath);
                if (existing) {
                  return prev.map((f) =>
                    f.path === args.filePath
                      ? {
                          ...f,
                          additions: f.additions + additions,
                          deletions: f.deletions + deletions,
                        }
                      : f,
                  );
                }
                return [...prev, { path: args.filePath!, additions, deletions }];
              });
            }
          } catch {}
        }

        const applyToolResult = () => {
          setStreamingParts((prev) =>
            prev.map((p) =>
              p.kind === "tool-call" && p.toolCallId === toolCallId
                ? { ...p, state: "completed" as const, resultContent }
                : p,
            ),
          );
        };

        const callStartTime = toolCallTimesRef.current[toolCallId];
        const elapsed = callStartTime ? Date.now() - callStartTime : TOOL_MIN_RUNNING_MS;
        const delay = Math.max(0, TOOL_MIN_RUNNING_MS - elapsed);

        if (delay > 0) {
          setTimeout(applyToolResult, delay);
        } else {
          applyToolResult();
        }
      }

      if (eventType === "tool.progress") {
        const progressCommand = eventRecord.command as string;
        const progressOutput = eventRecord.output as string;
        if (progressCommand && progressOutput) {
          setStreamingParts((prev) =>
            prev.map((p) => {
              if (p.kind !== "tool-call" || p.toolName !== "bash" || p.state !== "running")
                return p;
              try {
                const parsed = JSON.parse(p.toolInput ?? "{}") as { command?: string };
                if (parsed.command === progressCommand) {
                  return { ...p, liveOutput: progressOutput };
                }
              } catch {}
              return p;
            }),
          );
        }
      }

      if (eventType === "question.asked") {
        const questionPayload = eventData as {
          sessionId?: string;
          questions?: Array<{
            id: string;
            question: string;
            header: string;
            options: Array<{ label: string; description: string }>;
            multiple?: boolean;
            custom?: boolean;
          }>;
        };
        if (
          questionPayload.sessionId === currentSessionId &&
          questionPayload.questions &&
          questionPayload.questions.length > 0
        ) {
          setPendingQuestion({ questions: questionPayload.questions });
        }
      }

      if (eventType === "question.replied" || eventType === "question.rejected") {
        setPendingQuestion(null);
      }

      if (eventType === "permission.required") {
        const permPayload = eventData as {
          sessionId?: string;
          request?: PermissionRequest;
        };
        if (permPayload.sessionId === currentSessionId && permPayload.request) {
          setPendingPermission(permPayload.request);
        }
      }

      if (eventType === "permission.approved" || eventType === "permission.rejected") {
        setPendingPermission(null);
      }

      if (eventType === "todo.updated") {
        const todoPayload = eventData as {
          sessionId?: string;
          todos?: Array<{
            id: string;
            content: string;
            status: "pending" | "in_progress" | "completed" | "cancelled";
            priority?: "high" | "medium" | "low";
          }>;
        };
        if (todoPayload.sessionId === currentSessionId && todoPayload.todos) {
          setSessionTodos(todoPayload.todos);
        }
      }

      if (eventType === "part.updated" && eventRecord.type === "stream-complete") {
        const finalContent = (eventRecord.content as string) ?? "";

        const finalize = () => {
          finalizationTimerRef.current = null;
          setStreamingParts((currentParts) => {
            const hasContent = finalContent || currentParts.length > 0;

            if (hasContent) {
              setDisplayMessages((previousMessages) => [
                ...previousMessages,
                {
                  id: crypto.randomUUID(),
                  role: "assistant" as const,
                  text: finalContent,
                  parts: currentParts.length > 0 ? [...currentParts] : undefined,
                  modelId: modelIdAtStreamStartRef.current,
                  agentName: agentAtStreamStartRef.current.name,
                  agentColorKey: agentAtStreamStartRef.current.colorKey,
                  startedAt: previousMessages[previousMessages.length - 1]?.startedAt,
                  completedAt: Date.now(),
                },
              ]);
            }
            return [];
          });

          setIsProcessing(false);
        };

        const elapsed =
          streamFirstPartTimeRef.current > 0
            ? Date.now() - streamFirstPartTimeRef.current
            : MIN_STREAM_VISIBLE_MS;
        const delay = Math.max(0, MIN_STREAM_VISIBLE_MS - elapsed);

        if (delay > 0) {
          finalizationTimerRef.current = setTimeout(finalize, delay);
        } else {
          finalize();
        }
      }
    });

    return () => {
      removeEventHandler();
      if (finalizationTimerRef.current) {
        clearTimeout(finalizationTimerRef.current);
        finalizationTimerRef.current = null;
      }
    };
  }, [currentSessionId, sdk]);

  useEffect(() => {
    const removeUsageHandler = sdk.onEvent((eventType: string, eventData: unknown) => {
      if (eventType !== "usage.updated") return;
      const usageRecord = eventData as {
        sessionId?: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
      if (usageRecord.sessionId !== currentSessionId) return;

      const stepTokens = usageRecord.totalTokens ?? 0;
      setTotalTokenCount((previous) => previous + stepTokens);

      const modelInfo = getModelInfo(
        currentModelSelection.modelId,
        currentModelSelection.providerId,
      );
      if (modelInfo?.cost) {
        const inputCost = ((usageRecord.promptTokens ?? 0) / 1_000_000) * modelInfo.cost.input;
        const outputCost =
          ((usageRecord.completionTokens ?? 0) / 1_000_000) * modelInfo.cost.output;
        setTotalEstimatedCost((previous) => previous + inputCost + outputCost);
      }
    });
    return removeUsageHandler;
  }, [currentSessionId, sdk, currentModelSelection, getModelInfo]);

  const modelIdAtStreamStartRef = useRef(currentModelSelection.modelId);
  const agentAtStreamStartRef = useRef({ name: currentAgent.name, colorKey: currentAgent.color });

  useEffect(() => {
    if (isProcessing && streamingParts.length === 0) {
      modelIdAtStreamStartRef.current = currentModelSelection.modelId;
      agentAtStreamStartRef.current = { name: currentAgent.name, colorKey: currentAgent.color };
    }
  }, [isProcessing, streamingParts.length, currentModelSelection.modelId, currentAgent]);

  async function handlePromptSubmit(userInputText: string) {
    setRevertedMessages([]);
    setDisplayMessages((previousMessages) => [
      ...previousMessages,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: userInputText,
        startedAt: Date.now(),
      },
    ]);
    setIsProcessing(true);
    setStreamingParts([]);
    modelIdAtStreamStartRef.current = currentModelSelection.modelId;

    const fileReferencePattern = /(?<!\w)@(\.?[^\s,`]+(?:\.[^\s,`]+)*)/g;
    const fileParts: Array<{ path: string }> = [];
    for (const match of userInputText.matchAll(fileReferencePattern)) {
      if (match[1]) fileParts.push({ path: match[1] });
    }

    try {
      const response = await sdk.client.post(`/session/${currentSessionId}/message`, {
        content: userInputText,
        agentId: currentAgent.id,
        fileParts: fileParts.length > 0 ? fileParts : undefined,
      });
      if (!response.ok) {
        setIsProcessing(false);
      }
    } catch {
      setIsProcessing(false);
    }
  }

  const currentModelInfo = getModelInfo(
    currentModelSelection.modelId,
    currentModelSelection.providerId,
  );
  const contextLength = currentModelInfo?.contextLength ?? 0;
  const tokenPercentage =
    contextLength > 0 ? Math.min(100, Math.round((totalTokenCount / contextLength) * 100)) : 0;

  return (
    <SessionLayout
      sidebarProperties={{
        sessionTitle,
        tokenCount: totalTokenCount,
        tokenPercentage,
        estimatedCost: totalEstimatedCost,
        agentName: currentAgent.name,
        agentColor: currentAgentColor,
        todos: sessionTodos,
        modifiedFiles,
      }}
    >
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        paddingBottom={2}
        verticalScrollbarOptions={{
          paddingLeft: 1,
          paddingY: 1,
          trackOptions: {
            backgroundColor: theme.backgroundElement,
            foregroundColor: theme.border,
          },
        }}
      >
        {displayMessages.length === 0 && !isProcessing && <EmptyState />}
        {displayMessages.map((displayMessage) => (
          <box key={displayMessage.id} flexDirection="column">
            {displayMessage.role === "user" ? (
              <UserMessage messageText={displayMessage.text} />
            ) : (
              <>
                {displayMessage.parts
                  ? displayMessage.parts.map((part) => {
                      if (part.kind === "reasoning") {
                        return <ReasoningMessage key={part.id} reasoningText={part.content} />;
                      }
                      if (part.kind === "tool-call") {
                        return (
                          <ToolCallDisplay
                            key={part.id}
                            toolName={part.toolName}
                            toolInput={part.toolInput}
                            state={part.state}
                            resultContent={part.resultContent}
                          />
                        );
                      }
                      if (part.kind === "text") {
                        return (
                          <AssistantMessage
                            key={part.id}
                            messageText={part.content}
                            isStreaming={false}
                          />
                        );
                      }
                      return null;
                    })
                  : displayMessage.text && (
                      <AssistantMessage messageText={displayMessage.text} isStreaming={false} />
                    )}
                {displayMessage.completedAt && displayMessage.startedAt && (
                  <AssistantMetadata
                    agentName={displayMessage.agentName ?? currentAgent.name}
                    agentColor={resolveAgentColor(
                      displayMessage.agentColorKey ?? currentAgent.color,
                      theme,
                    )}
                    modelId={displayMessage.modelId ?? currentModelSelection.modelId}
                    durationSeconds={(displayMessage.completedAt - displayMessage.startedAt) / 1000}
                  />
                )}
              </>
            )}
          </box>
        ))}

        {isProcessing && streamingParts.length > 0 && (
          <box flexDirection="column">
            {streamingParts.map((part) => {
              if (part.kind === "reasoning") {
                return <ReasoningMessage key={part.id} reasoningText={part.content} isStreaming />;
              }
              if (part.kind === "tool-call") {
                return (
                  <ToolCallDisplay
                    key={part.id}
                    toolName={part.toolName}
                    toolInput={part.toolInput}
                    state={part.state}
                    resultContent={part.resultContent}
                    liveOutput={part.liveOutput}
                  />
                );
              }
              if (part.kind === "text") {
                return <AssistantMessage key={part.id} messageText={part.content} isStreaming />;
              }
              return null;
            })}
          </box>
        )}
      </scrollbox>

      {pendingPermission ? (
        <PermissionPrompt
          request={pendingPermission}
          agentColor={currentAgentColor}
          onApprove={() => {
            sdk.client
              .post(`/session/${currentSessionId}/permission/reply`, { approved: true })
              .catch(() => {});
            setPendingPermission(null);
          }}
          onApproveAlways={() => {
            const target = pendingPermission.filepath ?? pendingPermission.command ?? "";
            addAllowRule(pendingPermission.toolId, target);
            sdk.client
              .post(`/session/${currentSessionId}/permission/reply`, { approved: true })
              .catch(() => {});
            setPendingPermission(null);
          }}
          onReject={() => {
            sdk.client
              .post(`/session/${currentSessionId}/permission/reply`, { approved: false })
              .catch(() => {});
            setPendingPermission(null);
          }}
        />
      ) : pendingQuestion ? (
        <QuestionPrompt
          questions={pendingQuestion.questions}
          agentColor={currentAgentColor}
          onSubmit={(answers) => {
            sdk.client
              .post(`/session/${currentSessionId}/question/reply`, { answers })
              .catch(() => {});
            setPendingQuestion(null);
          }}
          onDismiss={() => {
            sdk.client.post(`/session/${currentSessionId}/question/reply`, {}).catch(() => {});
            setPendingQuestion(null);
          }}
        />
      ) : (
        <SessionPrompt
          onSubmit={handlePromptSubmit}
          disabled={isDialogOpen}
          isProcessing={isProcessing}
          agentName={currentAgent.name}
          agentColor={currentAgentColor}
          onToggleAgent={handleToggleAgent}
          undoAvailable={displayMessages.length > 0 && !isProcessing}
          redoAvailable={revertedMessages.length > 0 && !isProcessing}
          onInterrupt={() => {
            sdk.client.post(`/session/${currentSessionId}/cancel`, {}).catch(() => {});
            if (finalizationTimerRef.current) {
              clearTimeout(finalizationTimerRef.current);
              finalizationTimerRef.current = null;
            }
            setIsProcessing(false);
            setStreamingParts([]);
          }}
        />
      )}
    </SessionLayout>
  );
};
