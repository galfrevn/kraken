import { useState, useEffect, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS } from "@/theme.ts";
import type { TuiStore } from "@/store.ts";

const REFRESH_INTERVAL_MILLISECONDS = 1_500;

type LogLevel = "all" | "info" | "warn" | "error";
const LOG_LEVELS: LogLevel[] = ["all", "info", "warn", "error"];

type LogSource = "all" | "task" | "engine";
const LOG_SOURCES: LogSource[] = ["all", "task", "engine"];

const LOG_LEVEL_COLORS: Record<string, string> = {
  info: COLORS.textSecondary,
  warn: COLORS.yellow,
  error: COLORS.red,
  debug: COLORS.textMuted,
};

interface UnifiedLogEntry {
  timestamp: string;
  level: string;
  source: "task" | "engine";
  prefix: string;
  message: string;
}

interface LogsViewProps {
  store: TuiStore;
  focused: boolean;
}

export function LogsView({ store, focused }: LogsViewProps) {
  const [logs, setLogs] = useState<UnifiedLogEntry[]>([]);
  const [filterLevel, setFilterLevel] = useState<LogLevel>("all");
  const [filterSource, setFilterSource] = useState<LogSource>("all");

  const refresh = useCallback(() => {
    const taskLogs: UnifiedLogEntry[] = store.fetchAllLogs(200).map((log) => ({
      timestamp: log.created_at,
      level: log.level,
      source: "task" as const,
      prefix: log.task_id.slice(0, 8),
      message: log.message,
    }));

    const engineLogs: UnifiedLogEntry[] = store.fetchEngineLogs(200).map((log) => ({
      timestamp: log.created_at,
      level: log.level,
      source: "engine" as const,
      prefix: log.source.padEnd(8).slice(0, 8),
      message: log.message,
    }));

    const merged = [...taskLogs, ...engineLogs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    setLogs(merged);
  }, [store]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [refresh]);

  useKeyboard((key) => {
    if (!focused) return;

    if (key.name === "f") {
      setFilterLevel((current) => {
        const currentIndex = LOG_LEVELS.indexOf(current);
        const nextIndex = (currentIndex + 1) % LOG_LEVELS.length;
        return LOG_LEVELS[nextIndex]!;
      });
    }

    if (key.name === "s") {
      setFilterSource((current) => {
        const currentIndex = LOG_SOURCES.indexOf(current);
        const nextIndex = (currentIndex + 1) % LOG_SOURCES.length;
        return LOG_SOURCES[nextIndex]!;
      });
    }
  });

  const filteredLogs = logs
    .filter((log) => filterSource === "all" || log.source === filterSource)
    .filter((log) => filterLevel === "all" || log.level === filterLevel);

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={COLORS.textSecondary}>
          {filteredLogs.length +
            "/" +
            logs.length +
            " entries  ·  f level: " +
            filterLevel +
            "  ·  s source: " +
            filterSource}
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        width="100%"
        stickyScroll={true}
        stickyStart="bottom"
      >
        {filteredLogs.length === 0 ? (
          <text fg={COLORS.textMuted}>{"  no logs"}</text>
        ) : (
          filteredLogs.map((log, index) => {
            const levelColor = LOG_LEVEL_COLORS[log.level] ?? COLORS.textMuted;
            return (
              <text key={index} fg={levelColor}>
                {log.timestamp +
                  " " +
                  log.prefix.padEnd(8) +
                  " [" +
                  log.level.padEnd(5) +
                  "] " +
                  log.message}
              </text>
            );
          })
        )}
      </scrollbox>
    </box>
  );
}
