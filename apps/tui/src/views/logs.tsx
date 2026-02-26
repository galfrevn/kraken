import { useState, useEffect, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS } from "@/theme.ts";
import type { TuiStore } from "@/store.ts";
import type { TaskLogRow } from "@core/storage/database.ts";

const REFRESH_INTERVAL_MILLISECONDS = 1_500;

type LogLevel = "all" | "info" | "warn" | "error";
const LOG_LEVELS: LogLevel[] = ["all", "info", "warn", "error"];

const LOG_LEVEL_COLORS: Record<string, string> = {
  info: COLORS.textSecondary,
  warn: COLORS.yellow,
  error: COLORS.red,
  debug: COLORS.textMuted,
};

interface LogsViewProps {
  store: TuiStore;
  focused: boolean;
}

export function LogsView({ store, focused }: LogsViewProps) {
  const [logs, setLogs] = useState<TaskLogRow[]>([]);
  const [filterLevel, setFilterLevel] = useState<LogLevel>("all");

  const refresh = useCallback(() => {
    setLogs(store.fetchAllLogs(200));
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
  });

  const filteredLogs =
    filterLevel === "all"
      ? logs
      : logs.filter((log) => log.level === filterLevel);

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={COLORS.textSecondary}>
          {filteredLogs.length +
            "/" +
            logs.length +
            " entries  ·  f cycle filter  ·  filter: " +
            filterLevel}
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
            const taskPrefix = log.task_id.slice(0, 8);
            return (
              <text key={index} fg={levelColor}>
                {log.created_at +
                  " " +
                  taskPrefix +
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
