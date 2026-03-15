import "opentui-spinner/react";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

import { useDialog, useDialogKeyboard, useDialogState } from "@opentui-ui/dialog/react";
import { toast } from "@opentui-ui/toast/react";
import { SyntaxStyle, RGBA, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";

import { COLORS } from "@/theme.ts";

import type { ChatMessage, Plan, FileAttachment, PendingSetup } from "@/engine.ts";
import type { PendingQuestions, QuestionAnswer } from "@core/tools/question.ts";
import type { PendingConfirmation, ConfirmationDecision } from "@core/tools/confirmation.ts";
import type { DaemonStore } from "@/daemon-store.ts";
import type { ThreadManager } from "@/threads.ts";
import type { PluginRegistry, LoadedPlugin } from "@core/plugins/registry.ts";
import { installPluginFromRegistry, type PluginRegistryManifest } from "@core/plugins/installer.ts";

import {
  handleSlashCommand,
  ALL_COMMANDS,
  commandRequiresArguments,
  setPendingProviderSwitch,
  type SlashCommand,
  type CommandResult,
} from "@/commands.ts";
import {
  fetchAllAvailableModels,
  clearModelCaches,
  type ProviderModel,
} from "@core/tools/model.ts";
import { Avatar, type AvatarState } from "@/avatar.tsx";
import { loadImagePreview, generatePreviewRows } from "@/images.ts";
import { SetupPanel } from "@/views/setup.tsx";
import { ProviderSetupPanel, type ProviderOption } from "@/views/provider-setup.tsx";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#ff7b72"), bold: true },
  "keyword.return": { fg: RGBA.fromHex("#ff7b72"), bold: true },
  "keyword.function": { fg: RGBA.fromHex("#ff7b72"), bold: true },
  "keyword.operator": { fg: RGBA.fromHex("#ff7b72") },
  type: { fg: RGBA.fromHex("#ffa657") },
  "type.builtin": { fg: RGBA.fromHex("#ffa657") },
  constructor: { fg: RGBA.fromHex("#ffa657") },
  variable: { fg: RGBA.fromHex("#e6edf3") },
  "variable.builtin": { fg: RGBA.fromHex("#79c0ff") },
  "variable.parameter": { fg: RGBA.fromHex("#e6edf3") },
  property: { fg: RGBA.fromHex("#e6edf3") },
  constant: { fg: RGBA.fromHex("#79c0ff") },
  "constant.builtin": { fg: RGBA.fromHex("#79c0ff") },
  function: { fg: RGBA.fromHex("#d2a8ff") },
  "function.method": { fg: RGBA.fromHex("#d2a8ff") },
  "function.builtin": { fg: RGBA.fromHex("#d2a8ff") },
  string: { fg: RGBA.fromHex("#a5d6ff") },
  "string.special": { fg: RGBA.fromHex("#a5d6ff") },
  number: { fg: RGBA.fromHex("#79c0ff") },
  boolean: { fg: RGBA.fromHex("#79c0ff") },
  comment: { fg: RGBA.fromHex("#8b949e"), italic: true },
  operator: { fg: RGBA.fromHex("#ff7b72") },
  punctuation: { fg: RGBA.fromHex("#e6edf3") },
  "punctuation.bracket": { fg: RGBA.fromHex("#e6edf3") },
  "punctuation.delimiter": { fg: RGBA.fromHex("#e6edf3") },
  tag: { fg: RGBA.fromHex("#7ee787") },
  attribute: { fg: RGBA.fromHex("#79c0ff") },
  label: { fg: RGBA.fromHex("#79c0ff") },
  namespace: { fg: RGBA.fromHex("#ffa657") },
  embedded: { fg: RGBA.fromHex("#e6edf3") },
});

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"]);

function isImagePath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function extractFileAttachments(text: string): {
  cleanText: string;
  attachments: FileAttachment[];
} {
  // Match absolute paths (Windows: C:\... or Unix: /...) or quoted paths
  const pathPattern =
    /(?:"([^"]+\.[a-zA-Z0-9]+)"|'([^']+\.[a-zA-Z0-9]+)'|([A-Za-z]:\\[^\s,]+\.[a-zA-Z0-9]+)|(\/[^\s,]+\.[a-zA-Z0-9]+))/g;
  const attachments: FileAttachment[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text)) !== null) {
    const filePath = (match[1] ?? match[2] ?? match[3] ?? match[4])!;
    if (!isAbsolute(filePath)) continue;
    if (seen.has(filePath)) continue;
    if (!existsSync(filePath)) continue;
    seen.add(filePath);
    attachments.push({
      path: filePath,
      name: basename(filePath),
      isImage: isImagePath(filePath),
    });
  }

  if (attachments.length === 0) return { cleanText: text, attachments: [] };

  // Remove the file paths from the display text, keep only the message
  let cleanText = text;
  for (const att of attachments) {
    cleanText = cleanText
      .replace(`"${att.path}"`, "")
      .replace(`'${att.path}'`, "")
      .replace(att.path, "");
  }
  cleanText = cleanText.replace(/\s+/g, " ").trim();
  if (!cleanText) cleanText = attachments.map((a) => a.name).join(", ");

  return { cleanText, attachments };
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: "Read File",
  write_file: "Write File",
  edit_file: "Edit File",
  delete_file: "Delete File",
  move_file: "Move File",
  read_lines: "Read Lines",
  list_directory: "List Directory",
  glob_files: "Find Files",
  search_files: "Search",
  replace_in_files: "Find & Replace",
  run_command: "Run Command",
  environment: "Environment",
  code_outline: "Code Outline",
  diff_files: "Diff Files",
  count_tokens: "Count Tokens",
  view_image: "View Image",
  web_search: "Web Search",
  fetch_url: "Fetch URL",
  http_request: "HTTP Request",
  git_status: "Git Status",
  git_diff: "Git Diff",
  git_commit: "Git Commit",
  git_log: "Git Log",
  schedule_cron: "Schedule Cron",
  list_schedules: "List Schedules",
  delete_schedule: "Delete Schedule",
  schedule_watcher: "Watch Files",
  delete_watcher: "Delete Watcher",
  schedule_once: "Schedule Task",
  list_timers: "List Timers",
  cancel_timer: "Cancel Timer",
  task_list: "List Tasks",
  task_submit: "Submit Task",
  list_models: "List Models",
  current_model: "Current Model",
  switch_model: "Switch Model",
  remember: "Remember",
  recall: "Recall Memory",
  index_project: "Index Project",
  delegate: "Subagent",
  session_command: "Session",
  plugin_manager: "Plugins",
  ask_question: "Asked Question",
};

export function registerToolDisplayNames(names: Record<string, string>): void {
  Object.assign(TOOL_DISPLAY_NAMES, names);
}

function toolDisplayName(codeName: string): string {
  return TOOL_DISPLAY_NAMES[codeName] ?? codeName;
}

interface ToolGroup {
  type: "tool";
  call: ChatMessage;
  result?: ChatMessage;
}

type RenderItem = { type: "message"; message: ChatMessage } | ToolGroup;

function groupMessages(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  const consumedResults = new Set<number>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;

    if (message.role === "tool_call") {
      // Scan forward for the first unconsumed matching tool_result
      let matchedResult: ChatMessage | undefined;
      for (let j = index + 1; j < messages.length; j++) {
        const candidate = messages[j]!;
        if (
          candidate.role === "tool_result" &&
          candidate.toolName === message.toolName &&
          !consumedResults.has(j)
        ) {
          matchedResult = candidate;
          consumedResults.add(j);
          break;
        }
      }
      items.push({ type: "tool", call: message, result: matchedResult });
    } else if (message.role === "tool_result") {
      if (!consumedResults.has(index)) {
        items.push({ type: "tool", call: message, result: message });
      }
    } else {
      items.push({ type: "message", message });
    }
  }

  return items;
}

interface ContentSegment {
  type: "text" | "thinking" | "tool_call" | "plan";
  content: string;
}

function parseAssistantContent(raw: string): ContentSegment[] {
  // Extract plan blocks before cleaning
  const planBlocks: string[] = [];
  const withoutPlans = raw
    .replace(/<plan>([\s\S]*?)<\/plan>/g, (_, inner) => {
      planBlocks.push(inner);
      return "___PLAN_PLACEHOLDER___";
    })
    .replace(/<plan>[\s\S]*$/g, "");

  const cleaned = withoutPlans
    .replace(/<tool_result[\s\S]*?<\/tool_result>/g, "")
    .replace(/<tool_result[\s\S]*$/g, "")
    .replace(/<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/g, (_match, inner) => {
      return `<tool_call>${inner}</tool_call>`;
    })
    .replace(/<function_calls>\s*([\s\S]+)$/g, (_match, inner) => {
      return `<tool_call>${inner}`;
    });

  const segments: ContentSegment[] = [];

  const tagPattern = /<(thinking|tool_call)>([\s\S]*?)(<\/\1>|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      const textBefore = cleaned.slice(lastIndex, match.index).trim();
      if (textBefore) {
        segments.push({ type: "text", content: textBefore });
      }
    }

    const tagType = match[1] as "thinking" | "tool_call";
    const tagContent = match[2]?.trim() ?? "";

    if (tagContent) {
      segments.push({ type: tagType, content: tagContent });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < cleaned.length) {
    const tail = cleaned.slice(lastIndex).trim();
    if (tail) {
      segments.push({ type: "text", content: tail });
    }
  }

  if (segments.length === 0 && cleaned.trim()) {
    segments.push({ type: "text", content: cleaned.trim() });
  }

  // Expand plan placeholders into plan segments
  if (planBlocks.length > 0) {
    let planIdx = 0;
    const expanded: ContentSegment[] = [];
    for (const seg of segments) {
      if (seg.type === "text" && seg.content.includes("___PLAN_PLACEHOLDER___")) {
        const parts = seg.content.split("___PLAN_PLACEHOLDER___");
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]!.trim();
          if (part) expanded.push({ type: "text", content: part });
          if (i < parts.length - 1 && planIdx < planBlocks.length) {
            expanded.push({ type: "plan", content: planBlocks[planIdx]! });
            planIdx++;
          }
        }
      } else {
        expanded.push(seg);
      }
    }
    return expanded;
  }

  return segments;
}

function planToMarkdown(planXml: string): string {
  const goalMatch = planXml.match(/<goal>([\s\S]*?)<\/goal>/);
  const steps = [...planXml.matchAll(/<step>([\s\S]*?)<\/step>/g)].map((m) => m[1]!.trim());
  const goal = goalMatch ? goalMatch[1]!.trim() : "Plan";
  const lines = [`**${goal}**`, ""];
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  return lines.join("\n");
}

function stripXmlTags(content: string): string {
  return content
    .replace(/<plan>[\s\S]*?<\/plan>/g, "")
    .replace(/<plan>[\s\S]*$/g, "")
    .replace(/<tool_result[\s\S]*?<\/tool_result>/g, "")
    .replace(/<tool_result[\s\S]*$/g, "")
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/<function_calls>[\s\S]*$/g, "")
    .replace(/<invoke\s+name="[^"]*"[^>]*>[\s\S]*?<\/invoke>/g, "")
    .replace(/<invoke\s+name="[^"]*"\s*\/>/g, "")
    .replace(/<(?:antml:)?parameter\s+name="[^"]*"[^>]*>[\s\S]*?<\/(?:antml:)?parameter>/g, "")
    .replace(
      /<\/?(?:thinking|tool_call|result|name|parameters|model|command|path|content|query|pattern)>/g,
      "",
    )
    .trim();
}

interface ChatViewProps {
  threadManager: ThreadManager;
  daemonStore?: DaemonStore | null;
  focused: boolean;
  onRequestFocus: () => void;
  onRequestBlur: () => void;
  onQuestionStateChange?: (hasQuestions: boolean) => void;
}

const DOUBLE_ESCAPE_THRESHOLD_MILLISECONDS = 500;

export function ChatView({
  threadManager,
  daemonStore,
  focused,
  onRequestFocus,
  onRequestBlur,
  onQuestionStateChange,
}: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [processing, setProcessing] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [threadTitle, setThreadTitle] = useState(threadManager.getActiveThreadTitle());
  const [threadCount, setThreadCount] = useState(threadManager.getThreadCount());
  const [activeThreadId, setActiveThreadId] = useState(threadManager.getActiveThreadIdentifier());
  const [currentPlan, setCurrentPlan] = useState<Plan | null>(null);
  const [inPlanMode, setInPlanMode] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestions | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingSetup, setPendingSetup] = useState<PendingSetup | null>(null);
  const [providerSetupData, setProviderSetupData] = useState<ProviderOption[] | null>(null);

  useEffect(() => {
    onQuestionStateChange?.(
      pendingQuestions !== null || pendingConfirmation !== null || pendingSetup !== null,
    );
  }, [pendingQuestions, pendingConfirmation, pendingSetup, onQuestionStateChange]);

  const scrollboxRef = useRef<any>(null);

  useEffect(() => {
    const sb = scrollboxRef.current;
    if (!sb) return;
    const blocked = !!(pendingQuestions || pendingConfirmation || pendingSetup);
    sb.focusable = !blocked;
    if (blocked && typeof sb.blur === "function") {
      sb.blur();
    }
  }, [pendingQuestions, pendingConfirmation, pendingSetup]);

  const lastEscapeTimestamp = useRef(0);
  const textareaReference = useRef<TextareaRenderable>(null);
  const messageHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const historyDraftText = useRef("");
  const [commandFilter, setCommandFilter] = useState<string | null>(null);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const cachedModelIds = useRef<ProviderModel[]>([]);
  const modelFetchInFlight = useRef(false);
  const autocompleteAccepted = useRef(false);
  const commandFilterRef = useRef<string | null>(null);
  const selectedCommandIndexRef = useRef(0);
  const modelFilterRef = useRef<string | null>(null);
  const selectedModelIndexRef = useRef(0);

  const filteredCommands = useMemo(() => {
    if (commandFilter === null) return [];
    const query = commandFilter.toLowerCase();
    return ALL_COMMANDS.filter(
      (cmd) => cmd.name.startsWith(query) || cmd.aliases.some((a) => a.startsWith(query)),
    );
  }, [commandFilter]);

  const filteredModels = useMemo(() => {
    if (modelFilter === null) return [];
    const query = modelFilter.toLowerCase();
    if (!query) return cachedModelIds.current.slice(0, 20);
    return cachedModelIds.current
      .filter((m) => m.modelId.toLowerCase().includes(query))
      .slice(0, 20);
  }, [modelFilter]);

  // Keep refs in sync for handleSubmit (avoids stale closure)
  commandFilterRef.current = commandFilter;
  selectedCommandIndexRef.current = selectedCommandIndex;
  modelFilterRef.current = modelFilter;
  selectedModelIndexRef.current = selectedModelIndex;
  const filteredCommandsRef = useRef(filteredCommands);
  filteredCommandsRef.current = filteredCommands;
  const filteredModelsRef = useRef(filteredModels);
  filteredModelsRef.current = filteredModels;

  const renderer = useRenderer();
  const dialog = useDialog();
  const dialogIsOpen = useDialogState((state) => state.isOpen);

  const showCommandResult = useCallback(
    (result: CommandResult) => {
      if (result.displayMode === "plugin-browser") {
        const registry = result.data as PluginRegistry;
        dialog.show({
          content: () => <PluginBrowserContent registry={registry} />,
          size: "large",
        });
      } else if (result.displayMode === "plugin-store") {
        const { registry, pluginRegistry } = result.data as {
          registry: PluginRegistryManifest;
          pluginRegistry: PluginRegistry;
        };
        dialog.show({
          content: () => <PluginStoreContent registry={registry} pluginRegistry={pluginRegistry} />,
          size: "large",
        });
      } else if (result.displayMode === "provider-setup") {
        setProviderSetupData(result.data as ProviderOption[]);
      } else if (result.displayMode === "dialog") {
        dialog.show({
          content: () => (
            <box flexDirection="column" width="100%">
              <text>{result.output}</text>
            </box>
          ),
          size: "large",
        });
      } else {
        toast.info(result.output);
      }

      if (result.switchedThread) {
        setThreadTitle(threadManager.getActiveThreadTitle());
        setThreadCount(threadManager.getThreadCount());
        setActiveThreadId(threadManager.getActiveThreadIdentifier());
        const newEngine = threadManager.getActiveEngine();
        setMessages([...newEngine.getMessages()]);
      }

      // Sync plan mode indicator after any command (e.g. /plan toggle)
      setInPlanMode(threadManager.getActiveEngine().isPlanMode());
    },
    [dialog, threadManager],
  );

  const executeCommandDirectly = useCallback(
    async (command: SlashCommand) => {
      const result = await handleSlashCommand("/" + command.name, threadManager);
      if (result) {
        showCommandResult(result);
      }
    },
    [threadManager, showCommandResult],
  );

  const openCommandPalette = useCallback(() => {
    dialog.show({
      content: () => (
        <CommandPaletteContent
          onSelect={(command) => {
            dialog.close();

            if (commandRequiresArguments(command)) {
              const prefill = "/" + command.name + " ";
              const textarea = textareaReference.current;
              if (textarea) {
                textarea.selectAll();
                textarea.deleteChar();
                textarea.insertText(prefill);
              }
              setInputValue(prefill);
              onRequestFocus();
            } else {
              executeCommandDirectly(command);
            }
          }}
        />
      ),
      size: "large",
    });
  }, [dialog, executeCommandDirectly, onRequestFocus]);

  const updateCommandFilter = useCallback(() => {
    if (autocompleteAccepted.current) {
      autocompleteAccepted.current = false;
      return;
    }
    const textarea = textareaReference.current;
    if (!textarea) {
      setCommandFilter(null);
      setModelFilter(null);
      return;
    }
    const text = textarea.plainText;

    // Check for /model <partial> pattern
    const modelMatch = text.match(/^\/(model|m)\s(.*)$/i);
    if (modelMatch) {
      setCommandFilter(null);
      const partial = modelMatch[2] ?? "";
      setModelFilter(partial);
      setSelectedModelIndex(0);

      // Fetch models if not cached
      if (cachedModelIds.current.length === 0 && !modelFetchInFlight.current) {
        modelFetchInFlight.current = true;
        fetchAllAvailableModels()
          .then((models) => {
            cachedModelIds.current = models;
            setModelFilter((prev) => prev);
          })
          .catch(() => {})
          .finally(() => {
            modelFetchInFlight.current = false;
          });
      }
      return;
    }

    setModelFilter(null);

    if (text.startsWith("/") && !text.includes(" ") && text.length >= 1) {
      setCommandFilter(text.slice(1));
      setSelectedCommandIndex(0);
    } else {
      setCommandFilter(null);
    }
  }, []);

  const acceptCommand = useCallback((command: SlashCommand) => {
    const textarea = textareaReference.current;
    if (!textarea) return;
    const needsArgs = command.usage.includes("<");
    const wantsModelAutocomplete = command.name === "model";
    const replacement = "/" + command.name + (needsArgs || wantsModelAutocomplete ? " " : "");
    autocompleteAccepted.current = true;
    textarea.selectAll();
    textarea.deleteChar();
    textarea.insertText(replacement);
    setCommandFilter(null);
  }, []);

  const acceptModel = useCallback((model: ProviderModel) => {
    const textarea = textareaReference.current;
    if (!textarea) return;
    autocompleteAccepted.current = true;
    setPendingProviderSwitch(model.provider);
    textarea.selectAll();
    textarea.deleteChar();
    textarea.insertText("/model " + model.modelId);
    setModelFilter(null);
  }, []);

  useKeyboard((key) => {
    if (dialogIsOpen) return;
    if (pendingSetup) return;
    if (pendingQuestions) return;
    if (pendingConfirmation) return;

    if (key.name === "c" && !focused) {
      const selection = renderer.getSelection();
      if (selection) {
        const text = selection.getSelectedText();
        if (text) {
          renderer.copyToClipboardOSC52(text);
          toast.info("copied to clipboard");
        }
      }
      return;
    }

    if (!focused && key.name === "h") {
      openCommandPalette();
      return;
    }

    if (key.name === "escape" && processing) {
      const now = Date.now();
      if (now - lastEscapeTimestamp.current < DOUBLE_ESCAPE_THRESHOLD_MILLISECONDS) {
        const engine = threadManager.getActiveEngine();
        engine.cancelCurrentResponse();
        toast.warning("response cancelled");
        lastEscapeTimestamp.current = 0;
      } else {
        lastEscapeTimestamp.current = now;
      }
      return;
    }

    if (key.name === "escape" && (commandFilter !== null || modelFilter !== null)) {
      setCommandFilter(null);
      setModelFilter(null);
      return;
    }

    if (key.name === "tab" && key.shift) {
      const engine = threadManager.getActiveEngine();
      const next = !engine.isPlanMode();
      engine.setPlanMode(next);
      setInPlanMode(next);
      toast.info(next ? "plan mode" : "build mode");
      return;
    }

    if (!focused) return;

    // Command autocomplete navigation
    if (commandFilter !== null && filteredCommands.length > 0) {
      if (key.name === "up") {
        setSelectedCommandIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.name === "down") {
        setSelectedCommandIndex((prev) => Math.min(filteredCommands.length - 1, prev + 1));
        return;
      }
      if (key.name === "tab") {
        const selected = filteredCommands[selectedCommandIndex];
        if (selected) acceptCommand(selected);
        return;
      }
    }

    // Model autocomplete navigation
    if (modelFilter !== null && filteredModels.length > 0) {
      if (key.name === "up") {
        setSelectedModelIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.name === "down") {
        setSelectedModelIndex((prev) => Math.min(filteredModels.length - 1, prev + 1));
        return;
      }
      if (key.name === "tab") {
        const selected = filteredModels[selectedModelIndex];
        if (selected) acceptModel(selected);
        return;
      }
    }

    if (key.name === "up") {
      const textarea = textareaReference.current;
      if (!textarea) return;
      const currentText = textarea.plainText;
      if (currentText.includes("\n")) return;
      if (messageHistory.current.length === 0) return;

      if (historyIndex.current === -1) {
        historyDraftText.current = currentText;
        historyIndex.current = messageHistory.current.length - 1;
      } else if (historyIndex.current > 0) {
        historyIndex.current--;
      } else {
        return;
      }

      const entry = messageHistory.current[historyIndex.current]!;
      textarea.selectAll();
      textarea.deleteChar();
      textarea.insertText(entry);
    }

    if (key.name === "down") {
      if (historyIndex.current === -1) return;
      const textarea = textareaReference.current;
      if (!textarea) return;

      if (historyIndex.current < messageHistory.current.length - 1) {
        historyIndex.current++;
        const entry = messageHistory.current[historyIndex.current]!;
        textarea.selectAll();
        textarea.deleteChar();
        textarea.insertText(entry);
      } else {
        historyIndex.current = -1;
        textarea.selectAll();
        textarea.deleteChar();
        if (historyDraftText.current) {
          textarea.insertText(historyDraftText.current);
        }
        historyDraftText.current = "";
      }
    }

    // Track input for command autocomplete (runs after key is processed by textarea)
    setTimeout(updateCommandFilter, 0);
  });

  useEffect(() => {
    let currentEngineListener: ((messages: ChatMessage[]) => void) | null = null;
    let currentPlanListener: ((plan: Plan | null) => void) | null = null;
    let currentQuestionListener: ((q: PendingQuestions | null) => void) | null = null;
    let currentConfirmationListener: ((c: PendingConfirmation | null) => void) | null = null;
    let currentSetupListener: ((s: PendingSetup | null) => void) | null = null;
    let currentEngine: ReturnType<typeof threadManager.getActiveEngine> | null = null;
    let previousMessageCount = 0;
    let streamingUpdateTimer: ReturnType<typeof setTimeout> | null = null;

    function attachToEngine() {
      if (currentEngine && currentEngineListener) {
        currentEngine.removeEventListener(currentEngineListener);
      }
      if (currentEngine && currentPlanListener) {
        currentEngine.removePlanListener(currentPlanListener);
      }
      if (currentEngine && currentQuestionListener) {
        currentEngine.removeQuestionListener(currentQuestionListener);
      }

      currentEngine = threadManager.getActiveEngine();
      previousMessageCount = currentEngine.getMessages().length;
      let lastMessageCount = previousMessageCount;
      let lastProcessing = currentEngine.isProcessing();
      let lastQueueLength = 0;
      let lastPlanMode = currentEngine.isPlanMode();
      streamingUpdateTimer = null;

      currentEngineListener = (updatedMessages: ChatMessage[]) => {
        const nowProcessing = currentEngine!.isProcessing();
        const nowQueueLength = currentEngine!.getQueueLength();
        const nowPlanMode = currentEngine!.isPlanMode();
        const lastMsg = updatedMessages[updatedMessages.length - 1];
        const isStreaming = lastMsg?.streaming === true;

        // Messages changed structurally (new message, removed, or streaming finished)
        if (updatedMessages.length !== lastMessageCount || (lastMsg && !isStreaming)) {
          if (streamingUpdateTimer) {
            clearTimeout(streamingUpdateTimer);
            streamingUpdateTimer = null;
          }
          setMessages([...updatedMessages]);
          lastMessageCount = updatedMessages.length;
        } else if (isStreaming) {
          // During streaming, throttle content updates to ~50ms to reduce re-renders
          if (!streamingUpdateTimer) {
            streamingUpdateTimer = setTimeout(() => {
              streamingUpdateTimer = null;
              setMessages([...currentEngine!.getMessages()]);
            }, 50);
          }
        }

        if (nowProcessing !== lastProcessing) {
          setProcessing(nowProcessing);
          lastProcessing = nowProcessing;
        }
        if (nowQueueLength !== lastQueueLength) {
          setQueuedMessages(currentEngine!.getQueuedMessages());
          lastQueueLength = nowQueueLength;
        }
        if (nowPlanMode !== lastPlanMode) {
          setInPlanMode(nowPlanMode);
          lastPlanMode = nowPlanMode;
        }

        // Generate title once the agent finishes its first response
        if (!nowProcessing && threadManager.getActiveThreadTitle() === "new conversation") {
          threadManager.generateActiveThreadTitle().then(() => {
            setThreadTitle(threadManager.getActiveThreadTitle());
            threadManager.saveNow();
          });
        }

        for (let index = previousMessageCount; index < updatedMessages.length; index++) {
          const message = updatedMessages[index];
          if (!message) continue;

          if (message.role === "tool_result" && message.toolSuccess === false) {
            toast.error(message.toolName ?? "tool failed", {
              description: message.content.slice(0, 80),
            });
          }

          if (message.role === "error") {
            toast.error(message.content.slice(0, 100));
          }

          if (message.role === "status") {
            toast.warning(message.content);
          }
        }

        previousMessageCount = updatedMessages.length;
      };

      currentPlanListener = (plan: Plan | null) => {
        setCurrentPlan(plan ? { ...plan, steps: plan.steps.map((s) => ({ ...s })) } : null);
      };

      currentQuestionListener = (q: PendingQuestions | null) => {
        setPendingQuestions(q);
      };

      currentConfirmationListener = (c: PendingConfirmation | null) => {
        setPendingConfirmation(c);
      };

      currentSetupListener = (s: PendingSetup | null) => {
        setPendingSetup(s);
      };

      currentEngine.addEventListener(currentEngineListener);
      currentEngine.addPlanListener(currentPlanListener);
      currentEngine.addQuestionListener(currentQuestionListener);
      currentEngine.addConfirmationListener(currentConfirmationListener);
      currentEngine.addSetupListener(currentSetupListener);
      setMessages([...currentEngine.getMessages()]);
      setProcessing(currentEngine.isProcessing());
      setCurrentPlan(currentEngine.getPlan());
      setInPlanMode(currentEngine.isPlanMode());
      setThreadTitle(threadManager.getActiveThreadTitle());
      setThreadCount(threadManager.getThreadCount());
      setActiveThreadId(threadManager.getActiveThreadIdentifier());
    }

    attachToEngine();

    const threadChangeListener = () => {
      attachToEngine();
    };

    threadManager.onThreadChange(threadChangeListener);

    return () => {
      if (streamingUpdateTimer) clearTimeout(streamingUpdateTimer);
      if (currentEngine && currentEngineListener) {
        currentEngine.removeEventListener(currentEngineListener);
      }
      if (currentEngine && currentPlanListener) {
        currentEngine.removePlanListener(currentPlanListener);
      }
      if (currentEngine && currentQuestionListener) {
        currentEngine.removeQuestionListener(currentQuestionListener);
      }
      if (currentEngine && currentConfirmationListener) {
        currentEngine.removeConfirmationListener(currentConfirmationListener);
      }
      if (currentEngine && currentSetupListener) {
        currentEngine.removeSetupListener(currentSetupListener);
      }
      threadManager.offThreadChange(threadChangeListener);
    };
  }, [threadManager]);

  const handleSubmit = useCallback(async () => {
    // If autocomplete is open, accept the selection instead of submitting
    if (commandFilterRef.current !== null && filteredCommandsRef.current.length > 0) {
      const selected = filteredCommandsRef.current[selectedCommandIndexRef.current];
      if (selected) acceptCommand(selected);
      return;
    }
    if (modelFilterRef.current !== null && filteredModelsRef.current.length > 0) {
      const selected = filteredModelsRef.current[selectedModelIndexRef.current];
      if (selected) acceptModel(selected);
      return;
    }

    const textarea = textareaReference.current;
    const currentText = textarea ? textarea.plainText : inputValue;

    if (!currentText.trim()) return;

    messageHistory.current.push(currentText.trim());
    historyIndex.current = -1;
    historyDraftText.current = "";

    if (textarea) {
      textarea.selectAll();
      textarea.deleteChar();
    }
    setInputValue("");
    setCommandFilter(null);
    setModelFilter(null);

    const commandResult = await handleSlashCommand(currentText, threadManager);
    if (commandResult) {
      showCommandResult(commandResult);
      return;
    }

    if (daemonStore) {
      const truncatedTaskName =
        currentText.length > 80 ? currentText.slice(0, 77) + "..." : currentText;
      const submittedTaskId = await daemonStore.submitTask(
        truncatedTaskName,
        currentText,
        5,
      );

      if (submittedTaskId) {
        const submissionTimestamp = new Date();
        const userMessage: ChatMessage = {
          role: "user",
          content: currentText,
          timestamp: submissionTimestamp,
        };
        const daemonSubmissionMessage: ChatMessage = {
          role: "status",
          content: `Task submitted to daemon (ID: ${submittedTaskId}). Switch to Tasks tab to follow progress.`,
          timestamp: submissionTimestamp,
        };
        setMessages((previousMessages) => [
          ...previousMessages,
          userMessage,
          daemonSubmissionMessage,
        ]);
        toast.success(`Task submitted: ${submittedTaskId.slice(0, 8)}`);
      } else {
        toast.error("Failed to submit task to daemon");
      }
      return;
    }

    const engine = threadManager.getActiveEngine();

    // Route feedback to plan when a draft plan exists
    const activePlan = engine.getPlan();
    if (activePlan && activePlan.status === "draft") {
      engine.addPlanFeedback(currentText);
      return;
    }

    const { cleanText, attachments } = extractFileAttachments(currentText);
    engine.sendMessage(
      attachments.length > 0 ? cleanText : currentText,
      attachments.length > 0 ? attachments : undefined,
    );
    setQueuedMessages(engine.getQueuedMessages());

    // Update mode indicator immediately (planMode is consumed per-message)
    setInPlanMode(engine.isPlanMode());
  }, [inputValue, threadManager, daemonStore]);

  const engine = threadManager.getActiveEngine();
  const tokenUsage = engine.getTokenUsage();
  const tokenLabel =
    tokenUsage.requestCount > 0
      ? `${tokenUsage.totalPromptTokens + tokenUsage.totalCompletionTokens} tokens · ${tokenUsage.requestCount} requests`
      : "";

  const isStreaming = messages.some((m) => m.streaming);

  const avatarState: AvatarState = processing ? (isStreaming ? "working" : "thinking") : "idle";

  const threadLabel = threadCount > 1 ? `${threadTitle} (${threadCount} threads)` : threadTitle;

  const isDaemonModeActive = !!daemonStore;

  const isPlanActive =
    inPlanMode ||
    (currentPlan !== null &&
      (currentPlan.status === "draft" || currentPlan.status === "executing"));
  const modeColor = isPlanActive ? COLORS.green : COLORS.blue;
  const modeLabel = isPlanActive ? "Plan" : "Build";

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={modeColor}>{modeLabel}</text>
        <text fg={COLORS.textMuted}>{"  ·  "}</text>
        <text fg={isDaemonModeActive ? COLORS.yellow : COLORS.textMuted}>
          {isDaemonModeActive ? "daemon" : "local"}
        </text>
        <text fg={COLORS.textMuted}>{"  ·  "}</text>
        <text fg={COLORS.textSecondary}>{threadLabel}</text>
        <box flexGrow={1} />
        {tokenLabel ? <text fg={COLORS.textMuted}>{tokenLabel}</text> : null}
      </box>

      <scrollbox
        ref={scrollboxRef}
        key={activeThreadId}
        flexGrow={1}
        width="100%"
        paddingRight={1}
        stickyScroll={true}
        stickyStart="bottom"
        onMouseUp={onRequestBlur}
      >
        {messages.length === 0 ? <EmptyState /> : <MessageList messages={messages} />}
      </scrollbox>

      <box flexDirection="column" width="100%" flexShrink={0} marginTop={1}>
        {commandFilter !== null && filteredCommands.length > 0 ? (
          <box flexDirection="column" width="100%" paddingBottom={1}>
            {filteredCommands.map((cmd, idx) => {
              const isSelected = idx === selectedCommandIndex;
              const cmdName = "/" + cmd.name;
              const padding = " ".repeat(Math.max(1, 16 - cmdName.length));
              return (
                <box
                  key={cmd.name}
                  width="100%"
                  height={1}
                  backgroundColor={isSelected ? COLORS.cyan : undefined}
                  onMouseUp={() => acceptCommand(cmd)}
                >
                  <text fg={isSelected ? COLORS.background : COLORS.text}>
                    {cmdName + padding + cmd.description}
                  </text>
                </box>
              );
            })}
          </box>
        ) : modelFilter !== null && filteredModels.length > 0 ? (
          <box flexDirection="column" width="100%" paddingBottom={1}>
            {filteredModels.map((model, idx) => {
              const isSelected = idx === selectedModelIndex;
              const tag = `[${model.provider}]`.padEnd(14);
              return (
                <box
                  key={`${model.provider}:${model.modelId}`}
                  width="100%"
                  height={1}
                  flexDirection="row"
                  backgroundColor={isSelected ? COLORS.cyan : undefined}
                  onMouseUp={() => acceptModel(model)}
                >
                  <text fg={isSelected ? COLORS.background : COLORS.textMuted}>{"  " + tag}</text>
                  <text fg={isSelected ? COLORS.background : COLORS.text}>{model.modelId}</text>
                </box>
              );
            })}
          </box>
        ) : null}
        {queuedMessages.length > 0 ? (
          <box flexDirection="column" width="100%" paddingBottom={1}>
            {queuedMessages.map((msg, idx) => (
              <box key={idx} flexDirection="row" width="100%">
                <text fg={COLORS.textMuted}>{"  ⏳ "}</text>
                <text fg={COLORS.textSecondary}>
                  {msg.length > 80 ? msg.slice(0, 77) + "..." : msg}
                </text>
              </box>
            ))}
          </box>
        ) : null}
        {providerSetupData ? (
          <ProviderSetupPanel
            providers={providerSetupData}
            onComplete={(configured) => {
              setProviderSetupData(null);
              if (configured) {
                // Invalidate model caches so the new provider's models appear
                cachedModelIds.current = [];
                clearModelCaches();
                toast.success(`${configured.label} configured — models now available via /model`);
              }
            }}
          />
        ) : pendingSetup ? (
          <SetupPanel
            fields={pendingSetup.fields}
            onComplete={() => {
              const eng = threadManager.getActiveEngine();
              eng.resolveSetup();
            }}
          />
        ) : pendingConfirmation ? (
          <ConfirmationPanel
            confirmation={pendingConfirmation}
            onResolve={(decision) => {
              const eng = threadManager.getActiveEngine();
              eng.resolveConfirmation(decision);
            }}
          />
        ) : pendingQuestions ? (
          <QuestionPanel
            questions={pendingQuestions}
            onResolve={(answers) => {
              const eng = threadManager.getActiveEngine();
              eng.resolveQuestions(answers);
            }}
          />
        ) : (
          <box flexDirection="row" width="100%" height={6} flexShrink={0}>
            <box paddingRight={1} paddingTop={1} flexShrink={0}>
              <Avatar state={avatarState} />
            </box>
            <box flexShrink={0} width={1} height={6} backgroundColor={modeColor} />
            <box
              flexGrow={1}
              flexShrink={1}
              height={6}
              backgroundColor={COLORS.inputBackground}
              padding={1}
              overflow="scroll"
              onMouseUp={onRequestFocus}
            >
              <textarea
                ref={textareaReference}
                initialValue={inputValue}
                placeholder={
                  isDaemonModeActive
                    ? "describe a task for the daemon..."
                    : currentPlan?.status === "draft"
                      ? "give feedback on the plan..."
                      : currentPlan?.status === "executing"
                        ? "plan executing..."
                        : isPlanActive
                          ? "describe what to plan... (shift+tab to switch mode)"
                          : processing
                            ? "type to queue a message..."
                            : "message kraken..."
                }
                placeholderColor={COLORS.textMuted}
                backgroundColor={COLORS.inputBackground}
                textColor={COLORS.text}
                width="90%"
                height="100%"
                wrapMode="word"
                focused={focused && !dialogIsOpen}
                onSubmit={handleSubmit}
                keyBindings={[
                  { name: "return", action: "submit" },
                  { name: "return", ctrl: true, action: "newline" },
                  { name: "a", meta: true, action: "select-all" },
                  { name: "a", ctrl: true, action: "select-all" },
                ]}
              />
            </box>
          </box>
        )}
      </box>
    </box>
  );
}

function CommandPaletteContent({ onSelect }: { onSelect: (command: SlashCommand) => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const topDialog = useDialogState((state) => state.topDialog);

  useDialogKeyboard((key) => {
    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((previous) => Math.max(0, previous - 1));
      return;
    }

    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((previous) => Math.min(ALL_COMMANDS.length - 1, previous + 1));
      return;
    }

    if (key.name === "return") {
      const command = ALL_COMMANDS[selectedIndex];
      if (command) {
        onSelect(command);
      }
    }
  }, topDialog?.id ?? "");

  return (
    <box flexDirection="column" width="100%">
      <box paddingBottom={1}>
        <text fg={COLORS.blue}>{"commands"}</text>
        <text fg={COLORS.textMuted}>{"  ↑↓ navigate  enter select  esc close"}</text>
      </box>

      {ALL_COMMANDS.map((command, index) => {
        const isSelected = index === selectedIndex;
        const needsArguments = commandRequiresArguments(command);
        const aliasLabel =
          command.aliases.length > 0
            ? "  " + command.aliases.map((alias) => "/" + alias).join(" ")
            : "";

        return (
          <box
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            width="100%"
            backgroundColor={isSelected ? COLORS.background : undefined}
          >
            <box flexDirection="row" width="100%">
              <text fg={isSelected ? COLORS.blue : COLORS.textSecondary}>
                {(isSelected ? "→ " : "  ") + command.usage}
              </text>
              <text fg={COLORS.textMuted}>{aliasLabel}</text>
              {needsArguments ? <text fg={COLORS.textMuted}>{"  (opens input)"}</text> : null}
            </box>
            <box paddingLeft={4}>
              <text fg={isSelected ? COLORS.text : COLORS.textMuted}>{command.description}</text>
            </box>
          </box>
        );
      })}
    </box>
  );
}

function PluginBrowserContent({ registry }: { registry: PluginRegistry }) {
  const plugins = registry.getLoadedPlugins();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inspectingName, setInspectingName] = useState<string | null>(null);
  const topDialog = useDialogState((state) => state.topDialog);

  useDialogKeyboard((key) => {
    if (inspectingName !== null) {
      if (key.name === "backspace" || key.name === "left") {
        setInspectingName(null);
      }
      return;
    }

    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((previous) => Math.max(0, previous - 1));
      return;
    }

    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((previous) => Math.min(plugins.length - 1, previous + 1));
      return;
    }

    if (key.name === "return") {
      const plugin = plugins[selectedIndex];
      if (plugin) {
        setInspectingName(plugin.plugin.name);
      }
    }
  }, topDialog?.id ?? "");

  if (plugins.length === 0) {
    return (
      <box flexDirection="column" width="100%">
        <text fg={COLORS.textMuted}>{"no plugins installed"}</text>
      </box>
    );
  }

  if (inspectingName !== null) {
    const entry = registry.getPluginByName(inspectingName);
    if (!entry) {
      return (
        <box flexDirection="column" width="100%">
          <text fg={COLORS.red}>{`plugin "${inspectingName}" not found`}</text>
        </box>
      );
    }
    return <PluginDetailView entry={entry} />;
  }

  const activeCount = plugins.filter((p) => p.enabled).length;

  return (
    <box flexDirection="column" width="100%">
      <box paddingBottom={1} flexDirection="row">
        <text fg={COLORS.blue}>{"plugins"}</text>
        <text fg={COLORS.textMuted}>{`  ${plugins.length} installed, ${activeCount} active`}</text>
      </box>
      <box paddingBottom={1}>
        <text fg={COLORS.textMuted}>{"  ↑↓ navigate  enter inspect  esc close"}</text>
      </box>

      {plugins.map((entry, index) => {
        const isSelected = index === selectedIndex;
        const statusIcon = entry.enabled ? "●" : "○";
        const statusColor = entry.enabled ? COLORS.green : COLORS.textMuted;
        const toolCount = entry.plugin.tools?.length ?? 0;
        const hookCount = entry.plugin.hooks ? Object.keys(entry.plugin.hooks).length : 0;
        const extras: string[] = [];
        if (toolCount > 0) extras.push(`${toolCount} tool${toolCount > 1 ? "s" : ""}`);
        if (hookCount > 0) extras.push(`${hookCount} hook${hookCount > 1 ? "s" : ""}`);
        if (entry.plugin.promptExtension) extras.push("prompt");
        const extraLabel = extras.length > 0 ? `  (${extras.join(", ")})` : "";

        return (
          <box
            key={entry.plugin.name}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            width="100%"
            backgroundColor={isSelected ? COLORS.background : undefined}
          >
            <box flexDirection="row" width="100%">
              <text fg={isSelected ? COLORS.blue : COLORS.textSecondary}>
                {isSelected ? "→ " : "  "}
              </text>
              <text fg={statusColor}>{statusIcon + " "}</text>
              <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>{entry.plugin.name}</text>
              <text fg={COLORS.textMuted}>{" v" + entry.plugin.version + extraLabel}</text>
            </box>
            {entry.plugin.description ? (
              <box paddingLeft={5}>
                <text fg={COLORS.textMuted}>{entry.plugin.description}</text>
              </box>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}

function PluginDetailView({ entry }: { entry: LoadedPlugin }) {
  const { plugin, source, enabled, pluginContext } = entry;

  return (
    <box flexDirection="column" width="100%">
      <box paddingBottom={1}>
        <text fg={COLORS.textMuted}>{"← backspace to go back  esc close"}</text>
      </box>

      <box flexDirection="row" paddingBottom={1}>
        <text fg={enabled ? COLORS.green : COLORS.textMuted}>{enabled ? "● " : "○ "}</text>
        <text fg={COLORS.blue}>{plugin.name}</text>
        <text fg={COLORS.textMuted}>{" v" + plugin.version}</text>
      </box>

      {plugin.description ? (
        <box paddingBottom={1}>
          <text fg={COLORS.text}>{plugin.description}</text>
        </box>
      ) : null}

      <box flexDirection="column" paddingBottom={1}>
        {plugin.author ? <text fg={COLORS.textSecondary}>{"author: " + plugin.author}</text> : null}
        <text fg={COLORS.textSecondary}>{"status: " + (enabled ? "active" : "disabled")}</text>
        <text fg={COLORS.textSecondary}>{"source: " + source + " (" + entry.entry + ")"}</text>
      </box>

      {Object.keys(pluginContext.config).length > 0 ? (
        <box flexDirection="column" paddingBottom={1}>
          <text fg={COLORS.purple}>{"config"}</text>
          {Object.entries(pluginContext.config).map(([key, value]) => (
            <box key={key} paddingLeft={2}>
              <text fg={COLORS.textSecondary}>{key + ": " + JSON.stringify(value)}</text>
            </box>
          ))}
        </box>
      ) : null}

      {plugin.tools && plugin.tools.length > 0 ? (
        <box flexDirection="column" paddingBottom={1}>
          <text fg={COLORS.purple}>{"tools"}</text>
          {plugin.tools.map((tool) => {
            const paramList = tool.definition.parameters
              .map((p) => p.name + (p.required ? "" : "?"))
              .join(", ");
            return (
              <box key={tool.definition.name} flexDirection="column" paddingLeft={2}>
                <text fg={COLORS.cyan}>{"→ " + tool.definition.name + "(" + paramList + ")"}</text>
                <box paddingLeft={2}>
                  <text fg={COLORS.textMuted}>{tool.definition.description}</text>
                </box>
              </box>
            );
          })}
        </box>
      ) : null}

      {plugin.hooks
        ? (() => {
            const hookNames = Object.keys(plugin.hooks!).filter(
              (key) => typeof (plugin.hooks as Record<string, unknown>)[key] === "function",
            );
            return hookNames.length > 0 ? (
              <box paddingBottom={1}>
                <text fg={COLORS.purple}>{"hooks: "}</text>
                <text fg={COLORS.textSecondary}>{hookNames.join(", ")}</text>
              </box>
            ) : null;
          })()
        : null}

      {plugin.promptExtension ? (
        <box flexDirection="column">
          <text fg={COLORS.purple}>{"prompt extension"}</text>
          <box paddingLeft={2}>
            <text fg={COLORS.textMuted}>
              {'"' +
                plugin.promptExtension.slice(0, 120) +
                (plugin.promptExtension.length > 120 ? "..." : "") +
                '"'}
            </text>
          </box>
        </box>
      ) : null}
    </box>
  );
}

function PluginStoreContent({
  registry,
  pluginRegistry,
}: {
  registry: PluginRegistryManifest;
  pluginRegistry: PluginRegistry;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [installedSet, setInstalledSet] = useState<Set<string>>(() => {
    const loaded = pluginRegistry.getLoadedPlugins().map((p) => p.plugin.name);
    return new Set(loaded);
  });
  const topDialog = useDialogState((state) => state.topDialog);

  useDialogKeyboard((key) => {
    if (installingName) return;

    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((previous) => Math.max(0, previous - 1));
      return;
    }

    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((previous) => Math.min(registry.plugins.length - 1, previous + 1));
      return;
    }

    if (key.name === "return") {
      const entry = registry.plugins[selectedIndex];
      if (!entry || installedSet.has(entry.name)) return;

      setInstallingName(entry.name);
      setInstallMessage(`installing ${entry.name}...`);

      installPluginFromRegistry(entry.name)
        .then((result) => {
          if (result.success) {
            setInstalledSet((previous) => new Set([...previous, entry.name]));
            const warningText = result.warnings.length > 0 ? `\n${result.warnings.join("\n")}` : "";
            setInstallMessage(`${entry.name} installed${warningText}`);
          } else {
            setInstallMessage(`failed: ${result.error}`);
          }
          setInstallingName(null);
        })
        .catch((error) => {
          setInstallMessage(`error: ${error instanceof Error ? error.message : String(error)}`);
          setInstallingName(null);
        });
    }
  }, topDialog?.id ?? "");

  return (
    <box flexDirection="column" width="100%">
      <box paddingBottom={1} flexDirection="row">
        <text fg={COLORS.blue}>{"plugin store"}</text>
        <text fg={COLORS.textMuted}>{`  ${registry.plugins.length} available`}</text>
      </box>
      <box paddingBottom={1}>
        <text fg={COLORS.textMuted}>{"  ↑↓ navigate  enter install  esc close"}</text>
      </box>

      {registry.plugins.map((entry, index) => {
        const isSelected = index === selectedIndex;
        const installed = installedSet.has(entry.name);
        const statusIcon = installed ? "✓" : "○";
        const statusColor = installed ? COLORS.green : COLORS.textMuted;
        const toolLabel = `${entry.tools.length} tool${entry.tools.length !== 1 ? "s" : ""}`;
        const requiresLabel =
          entry.requires.length > 0 ? `  requires: ${entry.requires.join(", ")}` : "";

        return (
          <box
            key={entry.name}
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            width="100%"
            backgroundColor={isSelected ? COLORS.background : undefined}
          >
            <box flexDirection="row" width="100%">
              <text fg={isSelected ? COLORS.blue : COLORS.textSecondary}>
                {isSelected ? "→ " : "  "}
              </text>
              <text fg={statusColor}>{statusIcon + " "}</text>
              <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>{entry.name}</text>
              <text fg={COLORS.textMuted}>
                {" v" + entry.version + "  " + toolLabel + requiresLabel}
              </text>
            </box>
            <box paddingLeft={5}>
              <text fg={COLORS.textMuted}>{entry.description}</text>
            </box>
            {isSelected && entry.tools.length > 0 ? (
              <box paddingLeft={5}>
                <text fg={COLORS.cyan}>{entry.tools.join(", ")}</text>
              </box>
            ) : null}
          </box>
        );
      })}

      {installMessage ? (
        <box marginTop={1} paddingLeft={2}>
          <text fg={installingName ? COLORS.yellow : COLORS.green}>{installMessage}</text>
        </box>
      ) : null}
    </box>
  );
}

function QuestionPanel({
  questions,
  onResolve,
}: {
  questions: PendingQuestions;
  onResolve: (answers: QuestionAnswer[]) => void;
}) {
  const items = questions.items;
  const stepCount = items.length;
  const [activeStep, setActiveStep] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(() => items.map(() => []));
  const [cursor, setCursor] = useState<number[]>(() => items.map(() => 0));
  const [customTexts, setCustomTexts] = useState<string[]>(() => items.map(() => ""));
  const [editingCustom, setEditingCustom] = useState(false);
  const customInputRef = useRef<TextareaRenderable>(null);

  useEffect(() => {
    if (editingCustom) {
      // Focus after the textarea mounts
      setTimeout(() => customInputRef.current?.focus(), 0);
    }
  }, [editingCustom]);
  const isConfirmStep = activeStep === stepCount;
  const currentItem = items[activeStep];
  // +1 for the "Other..." option
  const totalOptions = (currentItem?.options.length ?? 0) + 1;
  const customIdx = currentItem?.options.length ?? 0;
  const currentCursor = cursor[activeStep] ?? 0;
  const isMultiple = currentItem?.multiple ?? false;
  const currentAnswers = answers[activeStep] ?? [];
  const isCursorOnCustom = currentCursor === customIdx;

  const formatAnswer = (ans: string[]): string => (ans.length > 0 ? ans.join(", ") : "(no answer)");

  const resolve = useCallback(() => {
    const result: QuestionAnswer[] = items.map((item, i) => ({
      question: item.question,
      answer: formatAnswer(answers[i] ?? []),
    }));
    onResolve(result);
  }, [items, answers, onResolve]);

  const toggleOption = useCallback(
    (label: string) => {
      setAnswers((prev) => {
        const next = [...prev];
        const current = next[activeStep] ?? [];
        if (isMultiple) {
          next[activeStep] = current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label];
        } else {
          next[activeStep] = [label];
        }
        return next;
      });
      if (!isMultiple && activeStep < stepCount) {
        setActiveStep((prev) => prev + 1);
      }
    },
    [activeStep, stepCount, isMultiple],
  );

  const submitCustomText = useCallback(() => {
    const text = customInputRef.current?.plainText?.trim() ?? "";
    if (!text) {
      setEditingCustom(false);
      return;
    }
    setCustomTexts((prev) => {
      const next = [...prev];
      next[activeStep] = text;
      return next;
    });
    setAnswers((prev) => {
      const next = [...prev];
      const current = (next[activeStep] ?? []).filter((a) =>
        items[activeStep]?.options.some((o) => o.label === a),
      );
      if (isMultiple) {
        next[activeStep] = [...current, text];
      } else {
        next[activeStep] = [text];
      }
      return next;
    });
    setEditingCustom(false);
    if (!isMultiple && activeStep < stepCount) {
      setActiveStep((prev) => prev + 1);
    }
  }, [activeStep, stepCount, isMultiple, items]);

  useKeyboard((key) => {
    // When editing custom text, only handle escape and enter
    if (editingCustom) {
      if (key.name === "escape") {
        setEditingCustom(false);
      } else if (key.name === "return") {
        submitCustomText();
      }
      return;
    }

    if (key.name === "escape") {
      resolve();
      return;
    }

    if ((key.name === "tab" && !key.shift) || key.name === "right") {
      setActiveStep((prev) => Math.min(stepCount, prev + 1));
      return;
    }
    if ((key.name === "tab" && key.shift) || key.name === "left") {
      setActiveStep((prev) => Math.max(0, prev - 1));
      return;
    }

    if (isConfirmStep) {
      if (key.name === "return") resolve();
      return;
    }

    if (key.name === "up" || key.name === "k") {
      setCursor((prev) => {
        const next = [...prev];
        next[activeStep] = Math.max(0, (next[activeStep] ?? 0) - 1);
        return next;
      });
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setCursor((prev) => {
        const next = [...prev];
        next[activeStep] = Math.min(totalOptions - 1, (next[activeStep] ?? 0) + 1);
        return next;
      });
      return;
    }

    if (key.name === "return" || (isMultiple && key.name === "space")) {
      if (isCursorOnCustom) {
        setEditingCustom(true);
        return;
      }
      const opt = currentItem?.options[currentCursor];
      if (opt) toggleOption(opt.label);
      return;
    }

    const num = parseInt(key.name ?? "", 10);
    if (num >= 1 && num <= (currentItem?.options.length ?? 0)) {
      toggleOption(currentItem!.options[num - 1]!.label);
    }
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      backgroundColor={COLORS.inputBackground}
      padding={1}
    >
      {/* Tab bar */}
      <box flexDirection="row" width="100%" paddingBottom={1}>
        {items.map((item, idx) => {
          const isActive = idx === activeStep;
          const hasAnswer = (answers[idx] ?? []).length > 0;
          const tabLabel = hasAnswer && !isActive ? "✓ " + item.title : item.title;
          return (
            <box key={idx} paddingRight={2}>
              <text
                fg={isActive ? COLORS.text : hasAnswer ? COLORS.green : COLORS.textMuted}
                bg={isActive ? COLORS.purple : undefined}
              >
                {isActive ? " " + item.title + " " : tabLabel}
              </text>
            </box>
          );
        })}
        <box>
          <text
            fg={isConfirmStep ? COLORS.text : COLORS.textMuted}
            bg={isConfirmStep ? COLORS.purple : undefined}
          >
            {isConfirmStep ? " Confirm " : "Confirm"}
          </text>
        </box>
      </box>

      {isConfirmStep ? (
        <box flexDirection="column" width="100%">
          {items.map((item, idx) => {
            const ans = answers[idx] ?? [];
            return (
              <box key={idx} flexDirection="column" width="100%" paddingBottom={1}>
                <text fg={COLORS.textMuted}>{item.question}</text>
                <text fg={ans.length > 0 ? COLORS.text : COLORS.textMuted}>
                  <b>{formatAnswer(ans)}</b>
                </text>
              </box>
            );
          })}
          <text>{""}</text>
          <text fg={COLORS.textMuted}>{"enter confirm  ← go back  esc dismiss"}</text>
        </box>
      ) : currentItem ? (
        <box flexDirection="column" width="100%">
          <text fg={COLORS.text}>
            <b>{currentItem.question + (isMultiple ? " (multiple)" : "")}</b>
          </text>
          <text>{""}</text>
          {currentItem.options.map((opt, idx) => {
            const isCursor = idx === currentCursor;
            const isChecked = currentAnswers.includes(opt.label);
            const checkbox = isMultiple ? (isChecked ? "◉ " : "○ ") : isChecked ? "● " : "○ ";
            const prefix = isCursor ? "→ " : "  ";
            return (
              <box key={idx} flexDirection="column" width="100%">
                <text fg={isChecked ? COLORS.green : isCursor ? COLORS.text : COLORS.textSecondary}>
                  {prefix + checkbox + (idx + 1) + ". " + opt.label}
                </text>
                {opt.description ? (
                  <text fg={COLORS.textMuted}>{"       " + opt.description}</text>
                ) : null}
              </box>
            );
          })}
          {/* Custom text option */}
          {(() => {
            const customText = customTexts[activeStep] ?? "";
            const hasCustom = currentAnswers.some(
              (a) => !currentItem.options.some((o) => o.label === a),
            );
            const checkbox = isMultiple ? (hasCustom ? "◉ " : "○ ") : hasCustom ? "● " : "○ ";
            const prefix = isCursorOnCustom ? "→ " : "  ";
            return (
              <box flexDirection="column" width="100%">
                <text
                  fg={
                    hasCustom ? COLORS.green : isCursorOnCustom ? COLORS.text : COLORS.textSecondary
                  }
                >
                  {prefix +
                    checkbox +
                    "Other..." +
                    (customText && !editingCustom ? " (" + customText + ")" : "")}
                </text>
              </box>
            );
          })()}
          {editingCustom ? (
            <box width="100%" height={2} paddingLeft={6} paddingTop={1}>
              <textarea
                ref={customInputRef}
                initialValue={customTexts[activeStep] ?? ""}
                placeholder="type your answer..."
                textColor={COLORS.text}
                backgroundColor={COLORS.backgroundDeep}
              />
            </box>
          ) : null}
          <text>{""}</text>
          <text fg={COLORS.textMuted}>
            {editingCustom
              ? "enter submit  esc cancel"
              : isMultiple
                ? "←→/tab navigate  ↑↓ move  enter/space toggle  esc dismiss"
                : "←→/tab navigate  ↑↓ move  enter select  esc dismiss"}
          </text>
        </box>
      ) : null}
    </box>
  );
}

function ConfirmationPanel({
  confirmation,
  onResolve,
}: {
  confirmation: PendingConfirmation;
  onResolve: (decision: ConfirmationDecision) => void;
}) {
  const [showReason, setShowReason] = useState(false);
  const reasonRef = useRef<TextareaRenderable>(null);

  useEffect(() => {
    if (showReason) {
      setTimeout(() => reasonRef.current?.focus(), 0);
    }
  }, [showReason]);

  const approve = useCallback(() => {
    onResolve({ approved: true });
  }, [onResolve]);

  const reject = useCallback(
    (reason?: string) => {
      onResolve({ approved: false, reason: reason || undefined });
    },
    [onResolve],
  );

  useKeyboard((key) => {
    if (showReason) {
      if (key.name === "escape") {
        setShowReason(false);
      } else if (key.name === "return") {
        const text = reasonRef.current?.plainText?.trim() ?? "";
        reject(text);
      }
      return;
    }

    if (key.name === "y" || key.name === "return") {
      approve();
    } else if (key.name === "n") {
      reject();
    } else if (key.name === "r") {
      setShowReason(true);
    } else if (key.name === "escape") {
      reject();
    }
  });

  const paramEntries = Object.entries(confirmation.parameters);

  return (
    <box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      backgroundColor={COLORS.inputBackground}
      padding={1}
    >
      <box flexDirection="row" width="100%" paddingBottom={1}>
        <text fg={COLORS.yellow}>{"⚠ "}</text>
        <text fg={COLORS.text}>
          <b>{"Tool requires confirmation"}</b>
        </text>
      </box>

      <box flexDirection="row" width="100%" paddingBottom={1}>
        <text fg={COLORS.textMuted}>{"tool: "}</text>
        <text fg={COLORS.purple}>
          <b>{confirmation.toolName}</b>
        </text>
      </box>

      {paramEntries.length > 0 ? (
        <box flexDirection="column" width="100%" paddingBottom={1}>
          <text fg={COLORS.textMuted}>{"parameters:"}</text>
          {paramEntries.map(([key, value], idx) => {
            const valueStr = typeof value === "string" ? value : JSON.stringify(value);
            const display = valueStr.length > 80 ? valueStr.slice(0, 77) + "..." : valueStr;
            return (
              <box key={idx} flexDirection="row" width="100%" paddingLeft={2}>
                <text fg={COLORS.textSecondary}>{key + ": "}</text>
                <text fg={COLORS.text}>{display}</text>
              </box>
            );
          })}
        </box>
      ) : null}

      {showReason ? (
        <box flexDirection="column" width="100%" paddingTop={1}>
          <text fg={COLORS.textMuted}>{"rejection reason:"}</text>
          <box width="100%" height={2} paddingTop={1}>
            <textarea
              ref={reasonRef}
              initialValue=""
              placeholder="type reason (optional)..."
              textColor={COLORS.text}
              backgroundColor={COLORS.backgroundDeep}
            />
          </box>
          <text>{""}</text>
          <text fg={COLORS.textMuted}>{"enter reject with reason  esc cancel"}</text>
        </box>
      ) : (
        <box flexDirection="row" width="100%" paddingTop={1} gap={2}>
          <text fg={COLORS.green}>
            <b>{"y/enter"}</b>
            {" approve"}
          </text>
          <text fg={COLORS.red}>
            <b>{"n/esc"}</b>
            {" reject"}
          </text>
          <text fg={COLORS.textMuted}>
            <b>{"r"}</b>
            {" reject with reason"}
          </text>
        </box>
      )}
    </box>
  );
}

function useIncrementalGrouping(messages: ChatMessage[]): RenderItem[] {
  const cacheRef = useRef<{ length: number; items: RenderItem[]; boundaryMsg?: ChatMessage }>({
    length: 0,
    items: [],
  });

  return useMemo(() => {
    const cached = cacheRef.current;
    const recompute = () => {
      const items = groupMessages(messages);
      cacheRef.current = {
        length: messages.length,
        items,
        boundaryMsg: messages[messages.length - 1],
      };
      return items;
    };

    // Messages removed/replaced (clear, new thread) — recompute fully
    if (messages.length < cached.length) {
      return recompute();
    }

    // Nothing new — but check if last message changed (streaming updates content in place)
    if (messages.length === cached.length) {
      const lastMsg = messages[messages.length - 1];
      const lastItem = cached.items[cached.items.length - 1];
      if (lastMsg && lastItem) {
        const lastCachedMsg =
          lastItem.type === "message"
            ? lastItem.message
            : lastItem.type === "tool"
              ? lastItem.result
              : undefined;
        if (lastCachedMsg && lastCachedMsg.content !== lastMsg.content) {
          return recompute();
        }
      }
      return cached.items;
    }

    // Messages grew — check if boundary message changed (happens when messages are
    // removed+replaced within a single debounce window, e.g. empty streaming assistant
    // removed and replaced by tool_call). If boundary shifted, recompute fully.
    if (cached.length > 0 && cached.boundaryMsg !== messages[cached.length - 1]) {
      return recompute();
    }

    // New messages appended — try to merge into last incomplete tool group first
    const newMessages = messages.slice(cached.length);
    const prevItems = [...cached.items];

    // If the last cached item is a tool group missing its result,
    // check if the first new message completes it
    const lastItem = prevItems[prevItems.length - 1];
    if (
      lastItem &&
      lastItem.type === "tool" &&
      !lastItem.result &&
      newMessages.length > 0 &&
      newMessages[0]!.role === "tool_result" &&
      newMessages[0]!.toolName === lastItem.call.toolName
    ) {
      prevItems[prevItems.length - 1] = { ...lastItem, result: newMessages[0]! };
      const remaining = newMessages.slice(1);
      const newItems = remaining.length > 0 ? groupMessages(remaining) : [];
      const items = [...prevItems, ...newItems];
      cacheRef.current = {
        length: messages.length,
        items,
        boundaryMsg: messages[messages.length - 1],
      };
      return items;
    }

    const newItems = groupMessages(newMessages);
    const items = [...prevItems, ...newItems];
    cacheRef.current = {
      length: messages.length,
      items,
      boundaryMsg: messages[messages.length - 1],
    };
    return items;
  }, [messages]);
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  const items = useIncrementalGrouping(messages);

  return (
    <box flexDirection="column" width="100%">
      {items.map((item, index) =>
        item.type === "tool" ? (
          <ToolAccordion key={index} call={item.call} result={item.result} />
        ) : (
          <MessageBubble key={index} message={item.message} />
        ),
      )}
    </box>
  );
}

function EmptyState() {
  return (
    <box flexDirection="row" padding={2}>
      <box flexDirection="column" flexShrink={0} width={2}>
        <text fg={COLORS.cyan}>{"┃"}</text>
        <text fg={COLORS.cyan}>{"┃"}</text>
        <text fg={COLORS.cyan}>{"┃"}</text>
        <text fg={COLORS.cyan}>{"┃"}</text>
        <text fg={COLORS.cyan}>{"┃"}</text>
        <text fg={COLORS.cyan}>{"┃"}</text>
        <text fg={COLORS.cyan}>{"┃"}</text>
        <text fg={COLORS.cyan}>{"┃"}</text>
      </box>
      <box flexDirection="column">
        <text fg={COLORS.text}>
          <b>{"kraken"}</b>
        </text>
        <text fg={COLORS.textMuted}>{"autonomous developer agent"}</text>
        <text fg={COLORS.textMuted}> </text>
        <text fg={COLORS.textMuted}>{"ask me anything about your codebase."}</text>
        <text fg={COLORS.textMuted}> </text>
        <text fg={COLORS.textMuted}>{"examples:"}</text>
        <text fg={COLORS.textSecondary}>{'  "list the files in this project"'}</text>
        <text fg={COLORS.textSecondary}>{'  "read package.json and explain the project"'}</text>
      </box>
    </box>
  );
}

function LeftBorder({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <box flexDirection="row" paddingTop={1} width="100%">
      <box flexShrink={0} width={2}>
        <text fg={color}>{"┃"}</text>
      </box>
      <box flexDirection="column" flexGrow={1} flexShrink={1} width="100%">
        {children}
      </box>
    </box>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  switch (message.role) {
    case "user":
      return (
        <LeftBorder color={COLORS.blue}>
          <box flexDirection="column" width="100%">
            <text fg={COLORS.text}>
              <b>{message.content}</b>
            </text>
            {message.attachments?.map((att, idx) => (
              <box key={idx} flexDirection="column" width="100%" paddingTop={1}>
                {att.isImage ? (
                  <InlineImagePreview path={att.path} name={att.name} />
                ) : (
                  <text fg={COLORS.textMuted}>{"📎 " + att.name}</text>
                )}
              </box>
            ))}
          </box>
        </LeftBorder>
      );

    case "assistant":
      return <AssistantBubble message={message} />;

    case "tool_call":
    case "tool_result":
      return null;

    case "error":
      return (
        <LeftBorder color={COLORS.red}>
          <text fg={COLORS.red}>{message.content}</text>
        </LeftBorder>
      );

    case "status":
      return (
        <LeftBorder color={COLORS.yellow}>
          <text fg={COLORS.yellow}>{message.content}</text>
        </LeftBorder>
      );

    default:
      return null;
  }
}

interface ImageResultData {
  type: "image";
  path: string;
  prompt?: string;
  description?: string;
  aspectRatio?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

function parseImageResult(content: string): ImageResultData | null {
  try {
    const data = JSON.parse(content);
    if (data && data.type === "image" && data.path) {
      return data as ImageResultData;
    }
  } catch {
    /* not json, try path detection */
  }

  const pathMatch =
    content.match(/(?:^|\s)(\/[^\s]+(?:\.png|\.jpg|\.jpeg|\.gif|\.bmp|\.webp))/i) ??
    content.match(/(?:^|\s)(\.[^\s]+(?:\.png|\.jpg|\.jpeg|\.gif|\.bmp|\.webp))/i);

  if (pathMatch?.[1] && content.length < 500) {
    return { type: "image", path: pathMatch[1] };
  }

  return null;
}

function InlineImagePreview({ path, name }: { path: string; name: string }) {
  const preview = useMemo(() => loadImagePreview(path, 30), [path]);
  const rows = useMemo(() => (preview ? generatePreviewRows(preview) : []), [preview]);

  if (!preview || rows.length === 0) {
    return <text fg={COLORS.textMuted}>{"🖼 " + name}</text>;
  }

  return (
    <box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <box flexDirection="row" key={rowIndex}>
          {row.map((segment, segmentIndex) => (
            <text key={segmentIndex} fg={segment.fg} bg={segment.bg}>
              {segment.text}
            </text>
          ))}
        </box>
      ))}
      <text fg={COLORS.textMuted}>
        {name + " · " + preview.originalWidth + "×" + preview.originalHeight}
      </text>
    </box>
  );
}

function ImageResultCard({ imageData }: { imageData: ImageResultData }) {
  const preview = useMemo(() => loadImagePreview(imageData.path, 50), [imageData.path]);
  const rows = useMemo(() => (preview ? generatePreviewRows(preview) : []), [preview]);

  const sizeLabel = imageData.sizeBytes
    ? imageData.sizeBytes > 1024 * 1024
      ? `${(imageData.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(imageData.sizeBytes / 1024)} KB`
    : "";

  const dimensionLabel =
    imageData.width && imageData.height
      ? `${imageData.width}×${imageData.height}`
      : preview
        ? `${preview.originalWidth}×${preview.originalHeight}`
        : "";

  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={COLORS.green}>{"✓ "}</text>
        <text fg={COLORS.purple}>{"Generate Image"}</text>
        {dimensionLabel ? <text fg={COLORS.textMuted}>{"  " + dimensionLabel}</text> : null}
        {sizeLabel ? <text fg={COLORS.textMuted}>{"  " + sizeLabel}</text> : null}
      </box>

      {rows.length > 0 ? (
        <box flexDirection="column" paddingBottom={1}>
          {rows.map((row, rowIndex) => (
            <box flexDirection="row" key={rowIndex}>
              {row.map((segment, segmentIndex) => (
                <text key={segmentIndex} fg={segment.fg} bg={segment.bg}>
                  {segment.text}
                </text>
              ))}
            </box>
          ))}
        </box>
      ) : null}

      <text fg={COLORS.textMuted}>{imageData.path}</text>
      {imageData.prompt ? (
        <text fg={COLORS.textSecondary}>{"prompt: " + imageData.prompt}</text>
      ) : null}
      {imageData.description ? (
        <text fg={COLORS.textSecondary}>{imageData.description}</text>
      ) : null}
    </box>
  );
}

function ToolExpandedContent({
  call,
  result,
  toolName,
}: {
  call: ChatMessage;
  result?: ChatMessage;
  toolName: string;
}) {
  const hasResult = result !== undefined && result !== call;
  const succeeded = result?.toolSuccess ?? true;
  const params = parseToolCallParams(call.content);
  const resultContent = hasResult ? (result.rawContent ?? result.content) : "";

  // Failed tool → always show error in red
  if (!succeeded && hasResult && resultContent) {
    return (
      <box flexDirection="column" paddingLeft={2} width="100%">
        {resultContent
          .split("\n")
          .slice(0, 30)
          .map((line, lineIndex) => (
            <box key={lineIndex} width="100%">
              <text fg={COLORS.red}>{line}</text>
            </box>
          ))}
        {resultContent.split("\n").length > 30 ? <text fg={COLORS.red}>{"..."}</text> : null}
      </box>
    );
  }

  // edit_file → show diff
  if (toolName === "edit_file" && params) {
    const oldStr = params.old_string as string | undefined;
    const newStr = params.new_string as string | undefined;
    const filePath = (params.path as string) ?? "file";
    if (oldStr && newStr) {
      const diffStr = generateUnifiedDiff(oldStr, newStr, filePath);
      return (
        <box flexDirection="column" paddingLeft={2} width="100%">
          <diff
            diff={diffStr}
            view="unified"
            syntaxStyle={syntaxStyle}
            addedBg={COLORS.diffAddedBg}
            removedBg={COLORS.diffRemovedBg}
            width="100%"
          />
        </box>
      );
    }
  }

  // write_file → show file content with syntax highlighting
  if (toolName === "write_file" && params) {
    const filePath = (params.path as string) ?? "";
    const content = (params.content as string) ?? "";
    const fileType = detectFileType(filePath);
    return (
      <box flexDirection="column" paddingLeft={2} width="100%">
        <code content={content} filetype={fileType} syntaxStyle={syntaxStyle} width="100%" />
      </box>
    );
  }

  // read_file / read_lines → show result with syntax highlighting
  if ((toolName === "read_file" || toolName === "read_lines") && hasResult) {
    const filePath = (params?.path as string) ?? "";
    const fileType = detectFileType(filePath);
    return (
      <box flexDirection="column" paddingLeft={2} width="100%">
        <code content={resultContent} filetype={fileType} syntaxStyle={syntaxStyle} width="100%" />
      </box>
    );
  }

  // run_command → show output as bash
  if (COMMAND_TOOLS.has(toolName) && hasResult) {
    return (
      <box flexDirection="column" paddingLeft={2} width="100%">
        <code content={resultContent} filetype="bash" syntaxStyle={syntaxStyle} width="100%" />
      </box>
    );
  }

  // git_diff → result is already unified diff
  if (toolName === "git_diff" && hasResult) {
    return (
      <box flexDirection="column" paddingLeft={2} width="100%">
        <diff
          diff={resultContent}
          view="unified"
          syntaxStyle={syntaxStyle}
          addedBg={COLORS.diffAddedBg}
          removedBg={COLORS.diffRemovedBg}
          width="100%"
        />
      </box>
    );
  }

  // git_log / git_status → show as shell output
  if ((toolName === "git_log" || toolName === "git_status") && hasResult) {
    return (
      <box flexDirection="column" paddingLeft={2} width="100%">
        <code content={resultContent} filetype="bash" syntaxStyle={syntaxStyle} width="100%" />
      </box>
    );
  }

  // Default: plain text input/output
  return (
    <box flexDirection="column" paddingLeft={2} width="100%">
      {call.content
        .split("\n")
        .slice(0, 20)
        .map((line, lineIndex) => (
          <box key={lineIndex} width="100%">
            <text fg={COLORS.textMuted}>{line}</text>
          </box>
        ))}
      {call.content.split("\n").length > 20 ? <text fg={COLORS.textMuted}>{"..."}</text> : null}
      {hasResult ? (
        <box flexDirection="column" marginTop={1} width="100%">
          {resultContent
            .split("\n")
            .slice(0, 20)
            .map((line, lineIndex) => (
              <box key={lineIndex} width="100%">
                <text fg={succeeded ? COLORS.textMuted : COLORS.red}>{line}</text>
              </box>
            ))}
          {resultContent.split("\n").length > 20 ? (
            <text fg={COLORS.textMuted}>{"..."}</text>
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

function QuestionResultBlock({ content }: { content: string }) {
  const lines = content.split("\n");
  const pairs: { question: string; answer: string }[] = [];
  let i = 0;
  // Skip "# Questions" header and blank lines
  while (i < lines.length && (lines[i]!.trim() === "" || lines[i]!.startsWith("# "))) i++;
  while (i < lines.length) {
    const question = lines[i]!;
    const answer = lines[i + 1] ?? "(no answer)";
    if (question.trim()) pairs.push({ question: question.trim(), answer: answer.trim() });
    i += 2;
    // skip blank lines between pairs
    while (i < lines.length && lines[i]!.trim() === "") i++;
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      backgroundColor={COLORS.inputBackground}
      padding={1}
      marginTop={1}
    >
      <text fg={COLORS.textMuted}>{"# Questions"}</text>
      {pairs.map((pair, idx) => (
        <box key={idx} flexDirection="column" width="100%" paddingTop={1}>
          <text fg={COLORS.textMuted}>{pair.question}</text>
          <text fg={COLORS.text}>
            <b>{pair.answer}</b>
          </text>
        </box>
      ))}
    </box>
  );
}

function ToolAccordion({ call, result }: { call: ChatMessage; result?: ChatMessage }) {
  const toolName = call.toolName ?? "tool";
  const name = toolDisplayName(toolName);
  const hasResult = result !== undefined && result !== call;
  const succeeded = result?.toolSuccess ?? true;
  const isInProgress = !hasResult;
  const statusIcon = hasResult ? (succeeded ? "✓" : "✗") : "";
  const statusColor = hasResult ? (succeeded ? COLORS.green : COLORS.red) : COLORS.textMuted;
  const [expanded, setExpanded] = useState(toolName === "edit_file" || !succeeded);
  const summary = buildToolSummary(call);

  const imageResult = hasResult && succeeded ? parseImageResult(result.content) : null;

  // Special rendering for ask_question results
  if (toolName === "ask_question" && hasResult && succeeded) {
    return <QuestionResultBlock content={result.content} />;
  }

  return (
    <box flexDirection="row" paddingTop={1} width="100%">
      <box flexShrink={0} width={2}>
        <text fg={COLORS.textMuted}>{"┃"}</text>
      </box>
      <box
        width="100%"
        flexDirection="column"
        onMouseUp={() => setExpanded((previous) => !previous)}
      >
        {imageResult ? (
          <ImageResultCard imageData={imageResult} />
        ) : (
          <>
            <box flexDirection="row" width="100%">
              {isInProgress ? (
                <spinner name="dots" color={COLORS.purple} />
              ) : (
                <text fg={statusColor}>{statusIcon}</text>
              )}
              <text fg={COLORS.purple}>{" " + name}</text>
              {summary ? <text fg={COLORS.textMuted}>{"  " + summary}</text> : null}
            </box>

            {expanded ? (
              <box backgroundColor={COLORS.backgroundDeep} width="100%" padding={1} marginTop={1}>
                <ToolExpandedContent call={call} result={result} toolName={toolName} />
              </box>
            ) : null}
          </>
        )}
      </box>
    </box>
  );
}

function buildToolSummary(call: ChatMessage): string {
  try {
    const parameters = JSON.parse(call.content);
    const toolName = call.toolName ?? "";

    if (parameters.path) return parameters.path;
    if (parameters.command)
      return parameters.command.length > 40
        ? parameters.command.slice(0, 40) + "..."
        : parameters.command;
    if (parameters.query)
      return parameters.query.length > 40
        ? parameters.query.slice(0, 40) + "..."
        : parameters.query;
    if (parameters.pattern) return parameters.pattern;
    if (parameters.url)
      return parameters.url.length > 40 ? parameters.url.slice(0, 40) + "..." : parameters.url;
    if (parameters.message && toolName === "git_commit")
      return parameters.message.length > 40
        ? parameters.message.slice(0, 40) + "..."
        : parameters.message;
    if (parameters.name) return parameters.name;
    if (parameters.model) return parameters.model;
    if (parameters.title) return parameters.title;

    return "";
  } catch {
    return "";
  }
}

const COMMAND_TOOLS = new Set(["run_command"]);

function parseToolCallParams(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// OpenTUI only bundles tree-sitter parsers for: javascript, typescript, markdown, zig.
// Map other filetypes to the closest compatible parser for syntax highlighting.
function detectFileType(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    // Native parsers
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    zig: "zig",
    // JSON → javascript (compatible: strings, numbers, booleans, brackets)
    json: "javascript",
    // C-family → javascript (reasonable keyword/brace highlighting)
    go: "javascript",
    rs: "javascript",
    java: "javascript",
    c: "javascript",
    cpp: "javascript",
    h: "javascript",
    hpp: "javascript",
    css: "javascript",
    scss: "javascript",
    // Scripting → javascript
    py: "javascript",
    rb: "javascript",
    sh: "javascript",
    bash: "javascript",
    zsh: "javascript",
    // Config/data → javascript (better than nothing)
    yaml: "javascript",
    yml: "javascript",
    toml: "javascript",
    sql: "javascript",
    html: "javascript",
    xml: "javascript",
    proto: "javascript",
  };
  return ext ? map[ext] : undefined;
}

function generateUnifiedDiff(oldStr: string, newStr: string, filePath: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const lines: string[] = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}

function extractToolNameFromPartialCall(content: string): string | undefined {
  const jsonNameMatch = content.match(/"name"\s*:\s*"([^"]+)"/);
  if (jsonNameMatch?.[1]) return jsonNameMatch[1];

  const invokeMatch = content.match(/<invoke\s+name="([^"]+)"/);
  if (invokeMatch?.[1]) return invokeMatch[1];

  const xmlNameMatch = content.match(/<name>\s*(\S+)\s*<\/name>/);
  if (xmlNameMatch?.[1]) return xmlNameMatch[1];

  return undefined;
}

function AssistantBubble({ message }: { message: ChatMessage }) {
  const displayContent = message.rawContent ?? message.content;
  const segments = useMemo(() => parseAssistantContent(displayContent), [displayContent]);
  const hasThinking = segments.some((s) => s.type === "thinking");
  const hasText = segments.some((s) => s.type === "text");
  const hasToolCall = segments.some((s) => s.type === "tool_call");

  const pendingToolName =
    message.streaming && hasToolCall ? extractToolNameFromPartialCall(displayContent) : undefined;

  const streamingHint = message.streaming
    ? hasThinking && !hasText
      ? "reasoning..."
      : pendingToolName
        ? `preparing ${pendingToolName}...`
        : hasToolCall && !hasText
          ? "preparing tool call..."
          : "streaming..."
    : null;

  return (
    <box flexDirection="row" paddingTop={1} width="100%">
      <box flexShrink={0} width={2}>
        <text fg={COLORS.cyan}>{"┃"}</text>
      </box>
      <box flexDirection="column" flexGrow={1} flexShrink={1} width="100%">
        {streamingHint ? (
          <box flexDirection="row">
            {message.streaming ? <spinner name="dots" color={COLORS.cyan} /> : null}
            <text fg={COLORS.textMuted}>{" " + streamingHint}</text>
          </box>
        ) : null}

        {segments.map((segment) => {
          if (segment.type === "thinking") {
            const cleaned = stripXmlTags(segment.content);
            if (!cleaned) return null;
            return (
              <box flexDirection="row" width="100%" paddingBottom={1}>
                <box flexShrink={0} width={2}>
                  <text fg={COLORS.textMuted}>{"┃"}</text>
                </box>
                <box flexDirection="column" flexGrow={1} width="100%">
                  <text fg={COLORS.textSecondary}>
                    <i>{cleaned}</i>
                  </text>
                </box>
              </box>
            );
          }

          if (segment.type === "plan") {
            const planMd = planToMarkdown(segment.content);
            return (
              <box flexDirection="row" width="100%" paddingTop={1} paddingBottom={1}>
                <box flexShrink={0} width={1} backgroundColor={COLORS.green} />
                <box flexGrow={1} paddingLeft={1} width="100%">
                  <markdown
                    content={planMd}
                    syntaxStyle={syntaxStyle}
                    conceal={true}
                    streaming={false}
                    width="100%"
                  />
                </box>
              </box>
            );
          }

          if (segment.type === "tool_call") {
            if (message.streaming) {
              const extractedToolName = extractToolNameFromPartialCall(segment.content);
              return extractedToolName ? (
                <box flexDirection="row" marginTop={1} width="100%">
                  <spinner name="dots" color={COLORS.purple} />
                  <text fg={COLORS.purple}>{" " + toolDisplayName(extractedToolName)}</text>
                </box>
              ) : null;
            }
            return null;
          }

          const cleaned = stripXmlTags(segment.content);
          if (!cleaned) return null;

          return (
            <box paddingRight={1} width="100%" flexShrink={0}>
              <markdown
                content={cleaned}
                syntaxStyle={syntaxStyle}
                streaming={message.streaming ?? false}
                width="100%"
              />
            </box>
          );
        })}
      </box>
    </box>
  );
}
