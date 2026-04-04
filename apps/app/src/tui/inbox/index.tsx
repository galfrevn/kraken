import { useState, useEffect } from "react";
import { useTerminalDimensions, useKeyboard, useRenderer } from "@opentui/react";
import { useRoute } from "@/tui/_context/route.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import type { DaemonEvent } from "@kraken/sdk";

const MAX_INBOX_ITEMS = 50;

interface InboxItem {
  id: string;
  event: DaemonEvent;
  receivedAt: Date;
  dismissed: boolean;
}

export const Inbox = () => {
  const { theme } = useTheme();
  const route = useRoute();
  const sdk = useSdk();
  const terminalDimensions = useTerminalDimensions();
  const renderer = useRenderer();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const unsubscribe = sdk.onEvent((eventType, eventData) => {
      if (!eventType.startsWith("daemon.")) return;

      const daemonEvent = eventData as DaemonEvent;
      if (!daemonEvent.task_id) return;

      setItems((previousItems) => {
        const newItem: InboxItem = {
          id: `${daemonEvent.task_id}-${Date.now()}`,
          event: daemonEvent,
          receivedAt: new Date(),
          dismissed: false,
        };
        const updatedItems = [newItem, ...previousItems];
        return updatedItems.slice(0, MAX_INBOX_ITEMS);
      });
    });
    return unsubscribe;
  }, []);

  const visibleItems = items.filter((item) => !item.dismissed);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "escape") {
      route.goHome();
      return;
    }

    if (keyEvent.name === "up" && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    }
    if (keyEvent.name === "down" && selectedIndex < visibleItems.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    }

    if (keyEvent.name === "d" && visibleItems.length > 0) {
      const targetItem = visibleItems[selectedIndex];
      if (targetItem) {
        setItems((previousItems) =>
          previousItems.map((item) =>
            item.id === targetItem.id ? { ...item, dismissed: true } : item,
          ),
        );
        if (selectedIndex >= visibleItems.length - 1 && selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1);
        }
      }
    }

    if (keyEvent.name === "return" && visibleItems.length > 0) {
      const targetItem = visibleItems[selectedIndex];
      if (targetItem) {
        handleAcceptItem(targetItem);
      }
    }

    if (keyEvent.ctrl && keyEvent.name === "c") {
      renderer.destroy();
      process.exit(0);
    }
  });

  function handleAcceptItem(item: InboxItem) {
    setItems((previousItems) =>
      previousItems.map((existingItem) =>
        existingItem.id === item.id ? { ...existingItem, dismissed: true } : existingItem,
      ),
    );
    route.goToSession(item.event.task_id, item.event.summary);
  }

  return (
    <box
      flexDirection="column"
      width={terminalDimensions.width}
      height={terminalDimensions.height}
      backgroundColor={theme.background}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingBottom={1}>
        <text
          fg={theme.primary}
          content={` Inbox ${visibleItems.length > 0 ? `(${visibleItems.length})` : ""}`}
        />
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted} content="enter accept" />
          <text fg={theme.textMuted} content="d dismiss" />
          <text fg={theme.textMuted} content="esc back" />
        </box>
      </box>

      <box flexDirection="column" flexGrow={1}>
        {visibleItems.length === 0 ? (
          <text
            fg={theme.textMuted}
            content="  No incoming events. Events from triggers, task completions, and alerts will appear here."
          />
        ) : (
          visibleItems.map((item, index) => (
            <InboxRow
              key={item.id}
              item={item}
              isSelected={index === selectedIndex}
              theme={theme}
            />
          ))
        )}
      </box>

      <box paddingTop={1} paddingBottom={1}>
        <text
          fg={theme.textMuted}
          content={`${visibleItems.length} items | ${items.filter((item) => item.dismissed).length} dismissed`}
        />
      </box>
    </box>
  );
};

function InboxRow({
  item,
  isSelected,
  theme,
}: {
  item: InboxItem;
  isSelected: boolean;
  theme: Record<string, string>;
}) {
  const nameColor = isSelected ? theme.primary : theme.text;
  const backgroundColor = isSelected ? theme.backgroundHighlight : undefined;
  const eventTypeLabel = formatEventType(item.event.event_type);
  const timeAgo = formatTimeAgo(item.receivedAt);

  return (
    <box flexDirection="row" gap={1} backgroundColor={backgroundColor} paddingLeft={1}>
      <text fg={theme.accent} content={eventTypeLabel} />
      <text fg={nameColor} content={item.event.summary} />
      <text fg={theme.textMuted} content={timeAgo} />
    </box>
  );
}

function formatEventType(eventType: string): string {
  const typeMap: Record<string, string> = {
    task_started: "[start]",
    task_completed: "[ ok ]",
    task_failed: "[fail]",
    task_cancelled: "[stop]",
    trigger_fired: "[trig]",
    pull_request_created: "[ pr ]",
    daily_digest: "[info]",
    cost_warning: "[warn]",
  };
  return typeMap[eventType] ?? `[${eventType}]`;
}

function formatTimeAgo(date: Date): string {
  const secondsAgo = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  const minutesAgo = Math.floor(secondsAgo / 60);
  if (minutesAgo < 60) return `${minutesAgo}m ago`;
  const hoursAgo = Math.floor(minutesAgo / 60);
  return `${hoursAgo}h ago`;
}
