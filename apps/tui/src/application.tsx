import { useState, useCallback, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { DialogProvider } from "@opentui-ui/dialog/react";
import { Toaster, toast } from "@opentui-ui/toast/react";
import { COLORS } from "@/theme.ts";
import type { TuiStore } from "@/store.ts";
import type { DaemonStore } from "@/daemon-store.ts";
import type { ThreadManager } from "@/threads.ts";
import type { PluginRegistry } from "@core/plugins/registry.ts";
import { ChatView } from "@/views/chat.tsx";
import { DashboardView } from "@/views/dashboard.tsx";
import { TasksView } from "@/views/tasks.tsx";
import { ReviewsView } from "@/views/reviews.tsx";
import { LogsView } from "@/views/logs.tsx";
import { ThreadSidebar } from "@/views/sidebar.tsx";
import { SetupPanel, type SetupField } from "@/views/setup.tsx";

const SIDEBAR_MIN_TERMINAL_WIDTH = 100;
const SIDEBAR_WIDTH = 28;

type ViewName = "chat" | "dashboard" | "tasks" | "reviews" | "logs";
const VIEWS: ViewName[] = ["chat", "dashboard", "tasks", "reviews", "logs"];

const TAB_LABELS: Record<ViewName, string> = {
  chat: "chat",
  dashboard: "dashboard",
  tasks: "tasks",
  reviews: "reviews",
  logs: "logs",
};

const VIEW_BY_NUMBER: Record<string, ViewName> = {
  "1": "chat",
  "2": "dashboard",
  "3": "tasks",
  "4": "reviews",
  "5": "logs",
};

export interface PluginLoadFailure {
  entry: string;
  error: string;
}

interface ApplicationProps {
  store: TuiStore;
  daemonStore?: DaemonStore | null;
  threadManager: ThreadManager;
  pluginRegistry: PluginRegistry;
  pluginFailures?: PluginLoadFailure[];
  pendingSetup?: SetupField[];
  onSetupComplete?: () => void;
}

export function Application({
  store,
  daemonStore,
  threadManager,
  pluginRegistry,
  pluginFailures,
  pendingSetup,
  onSetupComplete,
}: ApplicationProps) {
  const [activeView, setActiveView] = useState<ViewName>("chat");
  const [chatInputFocused, setChatInputFocused] = useState(true);
  const [hasQuestions, setHasQuestions] = useState(false);
  const [setupDone, setSetupDone] = useState(!pendingSetup || pendingSetup.length === 0);
  const { width, height } = useTerminalDimensions();

  useEffect(() => {
    if (pluginFailures && pluginFailures.length > 0) {
      for (const failure of pluginFailures) {
        toast.error(`plugin "${failure.entry}": ${failure.error}`);
      }
    }
  }, []);

  const navigateToView = useCallback((view: ViewName) => {
    setActiveView(view);
    setChatInputFocused(false);
  }, []);

  const requestChatFocus = useCallback(() => {
    setChatInputFocused(true);
  }, []);

  const requestChatBlur = useCallback(() => {
    setChatInputFocused(false);
  }, []);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "q") {
      process.exit(0);
    }

    // When question panel is active, block all navigation — QuestionPanel handles its own keys
    if (hasQuestions && activeView === "chat") {
      return;
    }

    if (key.name === "tab") {
      if (activeView === "chat") {
        setChatInputFocused((previous) => !previous);
      }
      return;
    }

    if (key.name === "escape" && activeView === "chat" && chatInputFocused) {
      setChatInputFocused(false);
      return;
    }

    if (activeView === "chat" && (chatInputFocused || hasQuestions)) {
      return;
    }

    if (key.name === "left" || key.name === "right") {
      const currentIndex = VIEWS.indexOf(activeView);
      const nextIndex =
        key.name === "right"
          ? (currentIndex + 1) % VIEWS.length
          : (currentIndex - 1 + VIEWS.length) % VIEWS.length;
      navigateToView(VIEWS[nextIndex]!);
      return;
    }

    const targetView = VIEW_BY_NUMBER[key.name ?? ""];
    if (targetView) {
      navigateToView(targetView);
    }
  });

  return (
    <DialogProvider
      size="medium"
      backdropColor={COLORS.background}
      backdropOpacity={0.8}
      dialogOptions={{
        style: {
          backgroundColor: COLORS.card,
          border: false,
          padding: 1,
        },
      }}
    >
      <Toaster
        position="top-right"
        stackingMode="stack"
        visibleToasts={4}
        maxWidth={50}
        offset={{ top: 2, right: 2 }}
        icons={false}
        toastOptions={{
          style: {
            backgroundColor: COLORS.surface,
            foregroundColor: COLORS.text,
            border: ["left"],
            borderColor: COLORS.textMuted,
            mutedColor: COLORS.textMuted,
            paddingX: 1,
            paddingY: 1,
            minHeight: 3,
          },
          duration: 3000,
          success: {
            style: { borderColor: COLORS.green },
          },
          info: {
            style: { borderColor: COLORS.blue },
          },
          warning: {
            style: { borderColor: COLORS.yellow },
            duration: 4000,
          },
          error: {
            style: { borderColor: COLORS.red },
            duration: 5000,
          },
        }}
      />

      <box flexDirection="column" width={width} height={height} backgroundColor={COLORS.background}>
        {!setupDone && pendingSetup && pendingSetup.length > 0 ? (
          <SetupPanel
            fields={pendingSetup}
            onComplete={() => {
              setSetupDone(true);
              onSetupComplete?.();
            }}
          />
        ) : (
          <>
            <Header activeView={activeView} chatInputFocused={chatInputFocused} />

            <box flexGrow={1} padding={1} gap={1} flexDirection="row">
              {activeView === "chat" && width >= SIDEBAR_MIN_TERMINAL_WIDTH && (
                <ThreadSidebar
                  threadManager={threadManager}
                  width={SIDEBAR_WIDTH}
                  onSelectThread={(identifier) => threadManager.switchThread(identifier)}
                />
              )}
              <box flexGrow={1} flexDirection="column">
                {activeView === "chat" && (
                  <ChatView
                    threadManager={threadManager}
                    focused={chatInputFocused}
                    onRequestFocus={requestChatFocus}
                    onRequestBlur={requestChatBlur}
                    onQuestionStateChange={setHasQuestions}
                  />
                )}
                {activeView === "dashboard" && (
                  <DashboardView store={store} daemonStore={daemonStore} pluginRegistry={pluginRegistry} />
                )}
                {activeView === "tasks" && (
                  <TasksView store={store} daemonStore={daemonStore} focused={activeView === "tasks"} />
                )}
                {activeView === "reviews" && (
                  <ReviewsView store={store} focused={activeView === "reviews"} />
                )}
                {activeView === "logs" && (
                  <LogsView store={store} focused={activeView === "logs"} />
                )}
              </box>
            </box>

            <Footer activeView={activeView} chatInputFocused={chatInputFocused} />
          </>
        )}
      </box>
    </DialogProvider>
  );
}

function Header({
  activeView,
  chatInputFocused,
}: {
  activeView: ViewName;
  chatInputFocused: boolean;
}) {
  const modeIndicator = activeView === "chat" && chatInputFocused ? "input" : "nav";

  return (
    <box
      flexDirection="row"
      backgroundColor={COLORS.surface}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      width="100%"
    >
      <text fg={COLORS.blue}>{"kraken"}</text>
      <text fg={COLORS.textMuted}>{"  │  "}</text>
      {VIEWS.map((view) => {
        const isActive = view === activeView;
        const label = TAB_LABELS[view];
        return (
          <box flexDirection="row" paddingRight={1}>
            <text fg={isActive ? COLORS.text : COLORS.textMuted}>{" " + label + " "}</text>
          </box>
        );
      })}
      <box flexGrow={1} />
      <text fg={COLORS.textMuted}>{"[" + modeIndicator + "]"}</text>
    </box>
  );
}

function Footer({
  activeView,
  chatInputFocused,
}: {
  activeView: ViewName;
  chatInputFocused: boolean;
}) {
  let hint: string;

  if (activeView === "chat" && chatInputFocused) {
    hint = "tab/esc nav mode  ·  esc×2 cancel  ·  ctrl+q quit";
  } else if (activeView === "chat") {
    hint = "←→ switch view  ·  h commands  ·  tab input  ·  ctrl+q quit";
  } else {
    hint = "←→ switch view  ·  ctrl+q quit";
  }

  return (
    <box
      flexDirection="row"
      backgroundColor={COLORS.surface}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      width="100%"
    >
      <text fg={COLORS.textMuted}>{hint}</text>
    </box>
  );
}
