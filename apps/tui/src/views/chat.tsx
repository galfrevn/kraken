import "opentui-spinner/react";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

import { useDialog, useDialogKeyboard, useDialogState } from "@opentui-ui/dialog/react";
import { toast } from "@opentui-ui/toast/react";
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";

import { COLORS } from "@/theme.ts";

import type { ChatMessage } from "@/engine.ts";
import type { ThreadManager } from "@/threads.ts";
import type { PluginRegistry, LoadedPlugin } from "@core/plugins/registry.ts";
import {
  installPluginFromRegistry,
  type PluginRegistryManifest,
} from "@core/plugins/installer.ts";

import { handleSlashCommand, ALL_COMMANDS, commandRequiresArguments, type SlashCommand, type CommandResult } from "@/commands.ts";
import { Avatar, type AvatarState } from "@/avatar.tsx";
import { loadImagePreview, generatePreviewRows } from "@/images.ts";

const syntaxStyle = SyntaxStyle.create();

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

type RenderItem =
  | { type: "message"; message: ChatMessage }
  | ToolGroup;

function groupMessages(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;

    if (message.role === "tool_call") {
      const next = messages[index + 1];
      if (next && next.role === "tool_result" && next.toolName === message.toolName) {
        items.push({ type: "tool", call: message, result: next });
        index++;
      } else {
        items.push({ type: "tool", call: message });
      }
    } else if (message.role === "tool_result") {
      items.push({ type: "tool", call: message, result: message });
    } else {
      items.push({ type: "message", message });
    }
  }

  return items;
}

interface ContentSegment {
  type: "text" | "thinking" | "tool_call";
  content: string;
}

function parseAssistantContent(raw: string): ContentSegment[] {
  const cleaned = raw
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

  return segments;
}

function stripXmlTags(content: string): string {
  return content
    .replace(/<tool_result[\s\S]*?<\/tool_result>/g, "")
    .replace(/<tool_result[\s\S]*$/g, "")
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
    .replace(/<function_calls>[\s\S]*$/g, "")
    .replace(/<invoke\s+name="[^"]*"[^>]*>[\s\S]*?<\/invoke>/g, "")
    .replace(/<invoke\s+name="[^"]*"\s*\/>/g, "")
    .replace(/<(?:antml:)?parameter\s+name="[^"]*"[^>]*>[\s\S]*?<\/(?:antml:)?parameter>/g, "")
    .replace(/<\/?(?:thinking|tool_call|result|name|parameters|model|command|path|content|query|pattern)>/g, "")
    .trim();
}

interface ChatViewProps {
  threadManager: ThreadManager;
  focused: boolean;
  onRequestFocus: () => void;
  onRequestBlur: () => void;
}

const DOUBLE_ESCAPE_THRESHOLD_MILLISECONDS = 500;

export function ChatView({ threadManager, focused, onRequestFocus, onRequestBlur }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [processing, setProcessing] = useState(false);
  const [queueLength, setQueueLength] = useState(0);
  const [threadTitle, setThreadTitle] = useState(threadManager.getActiveThreadTitle());
  const [threadCount, setThreadCount] = useState(threadManager.getThreadCount());
  const [activeThreadId, setActiveThreadId] = useState(threadManager.getActiveThreadIdentifier());
  const lastEscapeTimestamp = useRef(0);
  const textareaReference = useRef<TextareaRenderable>(null);
  const messageHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const historyDraftText = useRef("");

  const renderer = useRenderer();
  const dialog = useDialog();
  const dialogIsOpen = useDialogState((state) => state.isOpen);

  const showCommandResult = useCallback((result: CommandResult) => {
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
      const newEngine = threadManager.getActiveEngine();
      setMessages([...newEngine.getMessages()]);
    }
  }, [dialog, threadManager]);

  const executeCommandDirectly = useCallback(async (command: SlashCommand) => {
    const result = await handleSlashCommand("/" + command.name, threadManager);
    if (result) {
      showCommandResult(result);
    }
  }, [threadManager, showCommandResult]);

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

  useKeyboard((key) => {
    if (dialogIsOpen) return;

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

    if (!focused) return;

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
  });

  useEffect(() => {
    let currentEngineListener: ((messages: ChatMessage[]) => void) | null = null;
    let currentEngine: ReturnType<typeof threadManager.getActiveEngine> | null = null;
    let previousMessageCount = 0;

    function attachToEngine() {
      if (currentEngine && currentEngineListener) {
        currentEngine.removeEventListener(currentEngineListener);
      }

      currentEngine = threadManager.getActiveEngine();
      previousMessageCount = currentEngine.getMessages().length;

      currentEngineListener = (updatedMessages: ChatMessage[]) => {
        setMessages([...updatedMessages]);
        setProcessing(currentEngine!.isProcessing());
        setQueueLength(currentEngine!.getQueueLength());

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

      currentEngine.addEventListener(currentEngineListener);
      setMessages([...currentEngine.getMessages()]);
      setProcessing(currentEngine.isProcessing());
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
      if (currentEngine && currentEngineListener) {
        currentEngine.removeEventListener(currentEngineListener);
      }
      threadManager.offThreadChange(threadChangeListener);
    };
  }, [threadManager]);

  const handleSubmit = useCallback(async () => {
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

    const commandResult = await handleSlashCommand(currentText, threadManager);
    if (commandResult) {
      showCommandResult(commandResult);
      return;
    }

    const engine = threadManager.getActiveEngine();
    if (engine.isProcessing()) {
      toast("message queued", {
        description: currentText.slice(0, 60) + (currentText.length > 60 ? "..." : ""),
      });
    }
    engine.sendMessage(currentText);

    threadManager.generateActiveThreadTitle().then(() => {
      setThreadTitle(threadManager.getActiveThreadTitle());
    });

    threadManager.saveNow();
  }, [inputValue, threadManager]);

  const engine = threadManager.getActiveEngine();
  const tokenUsage = engine.getTokenUsage();
  const tokenLabel = tokenUsage.requestCount > 0
    ? `${tokenUsage.totalPromptTokens + tokenUsage.totalCompletionTokens} tokens · ${tokenUsage.requestCount} requests`
    : "";

  const isStreaming = messages.some((m) => m.streaming);

  const avatarState: AvatarState = processing
    ? isStreaming ? "working" : "thinking"
    : "idle";

  const threadLabel = threadCount > 1
    ? `${threadTitle} (${threadCount} threads)`
    : threadTitle;

  const queueLabel = queueLength > 0 ? ` · ${queueLength} queued` : "";
  const statusLabel = processing
    ? (isStreaming ? "streaming..." : "thinking...") + "  esc×2 cancel" + queueLabel
    : "h commands";

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={COLORS.textSecondary}>
          {threadLabel + "  ·  " + statusLabel + (tokenLabel ? "  ·  " + tokenLabel : "")}
        </text>
      </box>

      <scrollbox
        key={activeThreadId}
        flexGrow={1}
        width="100%"
        paddingRight={1}
        stickyScroll={true}
        stickyStart="bottom"
        onMouseUp={onRequestBlur}
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <box flexDirection="column" width="100%">
            {groupMessages(messages).map((item, index) =>
              item.type === "tool" ? (
                <ToolAccordion key={index} call={item.call} result={item.result} />
              ) : (
                <MessageBubble key={index} message={item.message} />
              ),
            )}
          </box>
        )}
      </scrollbox>

      <box flexDirection="column" width="100%" flexShrink={0} marginTop={1}>
        <box flexDirection="row" width="100%" height={6} flexShrink={0}>
          <box paddingRight={1} paddingTop={1} flexShrink={0}>
            <Avatar state={avatarState} />
          </box>
          <box
            flexGrow={1}
            height={6}
            backgroundColor={COLORS.inputBackground}
            padding={1}
            onMouseUp={onRequestFocus}
          >
            <textarea
              ref={textareaReference}
              initialValue={inputValue}
              placeholder={processing ? "type to queue a message..." : "message kraken..."}
              placeholderColor={COLORS.textMuted}
              backgroundColor={COLORS.inputBackground}
              textColor={COLORS.text}
              width="100%"
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
      </box>
    </box>
  );
}

function CommandPaletteContent({
  onSelect,
}: {
  onSelect: (command: SlashCommand) => void;
}) {
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
        const aliasLabel = command.aliases.length > 0
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
              {needsArguments ? (
                <text fg={COLORS.textMuted}>{"  (opens input)"}</text>
              ) : null}
            </box>
            <box paddingLeft={4}>
              <text fg={isSelected ? COLORS.text : COLORS.textMuted}>
                {command.description}
              </text>
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
              <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>
                {entry.plugin.name}
              </text>
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

      {plugin.hooks ? (() => {
        const hookNames = Object.keys(plugin.hooks!).filter(
          (key) => typeof (plugin.hooks as Record<string, unknown>)[key] === "function",
        );
        return hookNames.length > 0 ? (
          <box paddingBottom={1}>
            <text fg={COLORS.purple}>{"hooks: "}</text>
            <text fg={COLORS.textSecondary}>{hookNames.join(", ")}</text>
          </box>
        ) : null;
      })() : null}

      {plugin.promptExtension ? (
        <box flexDirection="column">
          <text fg={COLORS.purple}>{"prompt extension"}</text>
          <box paddingLeft={2}>
            <text fg={COLORS.textMuted}>
              {'"' + plugin.promptExtension.slice(0, 120) + (plugin.promptExtension.length > 120 ? "..." : "") + '"'}
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
            const warningText = result.warnings.length > 0
              ? `\n${result.warnings.join("\n")}`
              : "";
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
        const requiresLabel = entry.requires.length > 0
          ? `  requires: ${entry.requires.join(", ")}`
          : "";

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
              <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>
                {entry.name}
              </text>
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

function EmptyState() {
  return (
    <box flexDirection="column" padding={2}>
      <text fg={COLORS.text}>{"kraken"}</text>
      <text fg={COLORS.textMuted}>{"autonomous developer agent"}</text>
      <text fg={COLORS.textMuted}>{" "}</text>
      <text fg={COLORS.textMuted}>{"ask me anything about your codebase."}</text>
      <text fg={COLORS.textMuted}>{"i can read files, write code, run commands, and search."}</text>
      <text fg={COLORS.textMuted}>{" "}</text>
      <text fg={COLORS.textMuted}>{"examples:"}</text>
      <text fg={COLORS.textSecondary}>{'  "list the files in this project"'}</text>
      <text fg={COLORS.textSecondary}>{'  "read package.json and explain the project"'}</text>
      <text fg={COLORS.textSecondary}>{'  "create a hello world script in src/"'}</text>
    </box>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  switch (message.role) {
    case "user":
      return (
        <box flexDirection="column" paddingTop={1} paddingLeft={1} width="100%">
          <text fg={COLORS.blue}>{"→ you:"}</text>
          <text fg={COLORS.text}>{"  " + message.content}</text>
        </box>
      );

    case "assistant":
      return <AssistantBubble message={message} />;

    case "tool_call":
    case "tool_result":
      return null;

    case "error":
      return (
        <box flexDirection="column" paddingTop={1} paddingLeft={1} width="100%">
          <text fg={COLORS.red}>{"→ error"}</text>
          <text fg={COLORS.red}>{"  " + message.content}</text>
        </box>
      );

    case "status":
      return (
        <box paddingTop={1} paddingLeft={1}>
          <text fg={COLORS.yellow}>{"⚠ " + message.content}</text>
        </box>
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
  } catch { /* not json, try path detection */ }

  const pathMatch = content.match(/(?:^|\s)(\/[^\s]+(?:\.png|\.jpg|\.jpeg|\.gif|\.bmp|\.webp))/i)
    ?? content.match(/(?:^|\s)(\.[^\s]+(?:\.png|\.jpg|\.jpeg|\.gif|\.bmp|\.webp))/i);

  if (pathMatch?.[1] && content.length < 500) {
    return { type: "image", path: pathMatch[1] };
  }

  return null;
}

function ImageResultCard({ imageData }: { imageData: ImageResultData }) {
  const preview = useMemo(() => loadImagePreview(imageData.path, 50), [imageData.path]);
  const rows = useMemo(() => preview ? generatePreviewRows(preview) : [], [preview]);

  const sizeLabel = imageData.sizeBytes
    ? imageData.sizeBytes > 1024 * 1024
      ? `${(imageData.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(imageData.sizeBytes / 1024)} KB`
    : "";

  const dimensionLabel = imageData.width && imageData.height
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
                <text key={segmentIndex} fg={segment.fg} bg={segment.bg}>{segment.text}</text>
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

function ToolAccordion({ call, result }: { call: ChatMessage; result?: ChatMessage }) {
  const name = toolDisplayName(call.toolName ?? "tool");
  const hasResult = result !== undefined && result !== call;
  const succeeded = result?.toolSuccess ?? true;
  const statusIcon = hasResult ? (succeeded ? "✓" : "✗") : "⋯";
  const statusColor = hasResult ? (succeeded ? COLORS.green : COLORS.red) : COLORS.textMuted;
  const [expanded, setExpanded] = useState(false);
  const chevron = expanded ? "▾" : "▸";
  const summary = buildToolSummary(call);

  const imageResult = hasResult && succeeded ? parseImageResult(result.content) : null;

  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={1}
      width="100%"
    >
      <box
        backgroundColor={COLORS.inputBackground}
        width="100%"
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        onMouseUp={() => setExpanded((previous) => !previous)}
      >
        {imageResult ? (
          <ImageResultCard imageData={imageResult} />
        ) : (
          <>
            <box flexDirection="row" width="100%">
              <text fg={COLORS.textMuted}>{chevron + " "}</text>
              <text fg={statusColor}>{statusIcon + " "}</text>
              <text fg={COLORS.purple}>{name}</text>
              {summary ? (
                <text fg={COLORS.textMuted}>{"  " + summary}</text>
              ) : null}
            </box>

            {expanded ? (
              <box flexDirection="column" paddingLeft={4} width="100%">
                <box width="100%">
                  <text fg={COLORS.textMuted}>{"input"}</text>
                </box>
                {call.content.split("\n").slice(0, 12).map((line, lineIndex) => (
                  <box key={lineIndex} width="100%">
                    <text fg={COLORS.textSecondary}>{"  " + line}</text>
                  </box>
                ))}
                {call.content.split("\n").length > 12 ? (
                  <box width="100%">
                    <text fg={COLORS.textMuted}>{"  ..."}</text>
                  </box>
                ) : null}

                {hasResult ? (
                  <>
                    <box width="100%" marginTop={1}>
                      <text fg={COLORS.textMuted}>{"output"}</text>
                    </box>
                    {result.content.split("\n").slice(0, 12).map((line, lineIndex) => (
                      <box key={lineIndex} width="100%">
                        <text fg={succeeded ? COLORS.textSecondary : COLORS.red}>{"  " + line}</text>
                      </box>
                    ))}
                    {result.content.split("\n").length > 12 ? (
                      <box width="100%">
                        <text fg={COLORS.textMuted}>{"  ..."}</text>
                      </box>
                    ) : null}
                  </>
                ) : null}
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
    if (parameters.command) return parameters.command.length > 40 ? parameters.command.slice(0, 40) + "..." : parameters.command;
    if (parameters.query) return parameters.query.length > 40 ? parameters.query.slice(0, 40) + "..." : parameters.query;
    if (parameters.pattern) return parameters.pattern;
    if (parameters.url) return parameters.url.length > 40 ? parameters.url.slice(0, 40) + "..." : parameters.url;
    if (parameters.message && toolName === "git_commit") return parameters.message.length > 40 ? parameters.message.slice(0, 40) + "..." : parameters.message;
    if (parameters.name) return parameters.name;
    if (parameters.model) return parameters.model;
    if (parameters.title) return parameters.title;

    return "";
  } catch {
    return "";
  }
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
  const segments = parseAssistantContent(displayContent);
  const hasThinking = segments.some((s) => s.type === "thinking");
  const hasText = segments.some((s) => s.type === "text");
  const hasToolCall = segments.some((s) => s.type === "tool_call");

  const pendingToolName = message.streaming && hasToolCall
    ? extractToolNameFromPartialCall(displayContent)
    : undefined;

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
    <box flexDirection="column" paddingTop={1} paddingLeft={1} width="100%">
      <box flexDirection="row">
        {message.streaming ? (
          <spinner name="dots" color={COLORS.cyan} />
        ) : (
          <text fg={COLORS.cyan}>{"→"}</text>
        )}
        <text fg={COLORS.cyan}>{" kraken:"}</text>
        {streamingHint ? (
          <text fg={COLORS.textMuted}>{"  " + streamingHint}</text>
        ) : null}
      </box>

      {segments.map((segment) => {
        if (segment.type === "thinking") {
          const cleaned = stripXmlTags(segment.content);
          if (!cleaned) return null;
          return (
            <box
              flexDirection="column"
              paddingLeft={3}
              paddingRight={1}
              width="100%"
            >
              <box
                backgroundColor={COLORS.inputBackground}
                width="100%"
                paddingLeft={1}
                paddingRight={1}
                flexDirection="column"
              >
                <box flexDirection="row" width="100%">
                  <text fg={COLORS.textMuted}>{"reasoning"}</text>
                </box>
                <box width="100%">
                  <text fg={COLORS.textMuted}>{"  " + cleaned}</text>
                </box>
              </box>
            </box>
          );
        }

        if (segment.type === "tool_call") {
          if (message.streaming) {
            const toolName = extractToolNameFromPartialCall(segment.content);
            return toolName ? (
              <box
                flexDirection="column"
                paddingLeft={3}
                paddingRight={1}
                marginTop={1}
                width="100%"
              >
                <box
                  backgroundColor={COLORS.inputBackground}
                  width="100%"
                  paddingLeft={1}
                  paddingRight={1}
                  flexDirection="row"
                >
                  <spinner name="dots" color={COLORS.purple} />
                  <text fg={COLORS.purple}>{" " + toolDisplayName(toolName)}</text>
                </box>
              </box>
            ) : null;
          }
          return null;
        }

        const cleaned = stripXmlTags(segment.content);
        if (!cleaned) return null;

        return (
          <box paddingLeft={2} paddingRight={1} width="100%" flexShrink={0}>
            <markdown
              content={cleaned}
              syntaxStyle={syntaxStyle}
              streaming={message.streaming ?? false}
              width="100%"
            />
          </box>
        );
      })}

      {message.streaming ? (
        <text fg={COLORS.blue}>{"  ▊"}</text>
      ) : null}
    </box>
  );
}
