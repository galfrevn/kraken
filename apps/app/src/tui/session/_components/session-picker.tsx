import { useState, useEffect, useCallback } from "react";
import { type ChoiceContext } from "@opentui-ui/dialog/react";
import { useKeyboard } from "@opentui/react";

interface SessionEntry {
  id: string;
  title: string;
  timeUpdated: number;
}

interface SessionPickerProperties extends ChoiceContext<{ id: string }> {
  sdk: { client: { fetch: (path: string, options?: RequestInit) => Promise<Response> } };
  theme: Record<string, string>;
}

export const SessionPickerContent = ({ resolve, sdk, theme }: SessionPickerProperties) => {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sdk.client
      .fetch("/session")
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as {
          sessions: Array<{
            id: string;
            title: string;
            time_updated?: number;
            timeUpdated?: number;
          }>;
        };
        const entries: SessionEntry[] = (data.sessions ?? [])
          .map((s) => ({
            id: s.id,
            title: s.title || "Untitled",
            timeUpdated: s.time_updated ?? s.timeUpdated ?? 0,
          }))
          .slice(0, 50);
        setSessions(entries);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const selectCurrent = useCallback(() => {
    const session = sessions[selectedIndex];
    if (session) resolve({ id: session.id });
  }, [sessions, selectedIndex, resolve]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "up" || (keyEvent.ctrl && keyEvent.name === "k")) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (keyEvent.name === "down" || (keyEvent.ctrl && keyEvent.name === "j")) {
      setSelectedIndex((i) => Math.min(sessions.length - 1, i + 1));
    } else if (keyEvent.name === "return") {
      selectCurrent();
    } else if (keyEvent.name === "escape") {
      resolve(undefined as unknown as { id: string });
    }
  });

  if (loading) {
    return (
      <box paddingX={2} paddingY={1}>
        <text fg={theme.textMuted} content="Loading sessions..." />
      </box>
    );
  }

  if (sessions.length === 0) {
    return (
      <box paddingX={2} paddingY={1}>
        <text fg={theme.textMuted} content="No previous sessions found." />
      </box>
    );
  }

  return (
    <box flexDirection="column" paddingX={1} paddingY={1}>
      <box paddingBottom={1} paddingLeft={1}>
        <text fg={theme.text} content="Resume a session" />
      </box>
      <scrollbox flexGrow={1}>
        {sessions.map((session, index) => {
          const isSelected = index === selectedIndex;
          const timeAgo = formatTimeAgo(session.timeUpdated);
          return (
            <box
              key={session.id}
              paddingX={1}
              backgroundColor={isSelected ? theme.backgroundElement : undefined}
              onMouseUp={() => {
                setSelectedIndex(index);
                selectCurrent();
              }}
            >
              <text>
                <span fg={isSelected ? theme.primary : theme.text}>{isSelected ? "▸ " : "  "}</span>
                <span fg={isSelected ? theme.text : theme.textMuted}>
                  {session.title.length > 60 ? session.title.slice(0, 57) + "..." : session.title}
                </span>
                <span fg={theme.textMuted}> · {timeAgo}</span>
              </text>
            </box>
          );
        })}
      </scrollbox>
      <box paddingTop={1} paddingLeft={1}>
        <text fg={theme.textMuted} content="↑↓ navigate · enter select · esc cancel" />
      </box>
    </box>
  );
};

function formatTimeAgo(timestampMs: number): string {
  if (!timestampMs) return "";
  const diffMs = Date.now() - timestampMs;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestampMs).toLocaleDateString();
}
