import "opentui-spinner/react";

import { useState, useEffect } from "react";
import { COLORS } from "@/theme.ts";
import type { ThreadManager, ThreadSummary } from "@/threads.ts";

interface ThreadSidebarProps {
  threadManager: ThreadManager;
  width: number;
  onSelectThread: (identifier: string) => void;
}

export function ThreadSidebar({ threadManager, width, onSelectThread }: ThreadSidebarProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>(threadManager.listThreads());

  useEffect(() => {
    const refreshThreadList = () => {
      setThreads(threadManager.listThreads());
    };

    threadManager.onThreadChange(refreshThreadList);

    // Poll to detect processing state changes (engine events don't propagate to sidebar)
    const interval = setInterval(refreshThreadList, 1000);

    return () => {
      threadManager.offThreadChange(refreshThreadList);
      clearInterval(interval);
    };
  }, [threadManager]);

  const maxTitleLength = width - 8;

  const truncateTitle = (title: string): string => {
    if (title.length <= maxTitleLength) return title;
    return title.slice(0, maxTitleLength - 1) + "…";
  };

  return (
    <box
      flexDirection="column"
      width={width}
      flexShrink={0}
      backgroundColor={COLORS.backgroundDeep}
      padding={1}
      marginRight={1}
    >
      <box flexDirection="row" width="100%" paddingLeft={1} paddingBottom={1}>
        <text fg={COLORS.textSecondary}>{"threads"}</text>
        <box flexGrow={1} />
        <box onMouseUp={() => {
          threadManager.createThread();
          setThreads(threadManager.listThreads());
        }}>
          <text fg={COLORS.textMuted}>{"[+]"}</text>
        </box>
      </box>

      {threads.map((thread) => {
        const isActive = thread.active;
        const prefix = isActive ? "→ " : "  ";
        const title = truncateTitle(thread.title);
        const count = thread.messageCount > 0 ? ` (${thread.messageCount})` : "";

        return (
          <box
            key={thread.identifier}
            flexDirection="row"
            width="100%"
            paddingLeft={1}
            backgroundColor={isActive ? COLORS.inputBackground : undefined}
            onMouseUp={() => onSelectThread(thread.identifier)}
          >
            <text fg={isActive ? COLORS.cyan : COLORS.textMuted}>
              {prefix + title}
            </text>
            <box flexGrow={1} />
            {thread.isProcessing ? (
              <spinner fg={COLORS.cyan} />
            ) : count ? (
              <text fg={COLORS.textMuted}>{count}</text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
