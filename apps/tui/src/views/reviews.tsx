import { useState, useEffect, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS } from "@/theme.ts";
import type { TuiStore } from "@/store.ts";
import type { Task } from "@core/queue/schema.ts";

const REFRESH_INTERVAL_MILLISECONDS = 2_000;

interface ReviewsViewProps {
  store: TuiStore;
  focused: boolean;
}

export function ReviewsView({ store, focused }: ReviewsViewProps) {
  const [pendingReviews, setPendingReviews] = useState<Task[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState("");

  const refresh = useCallback(() => {
    setPendingReviews(store.taskQueueManager.listTasksAwaitingReview());
  }, [store]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);
    return () => clearInterval(interval);
  }, [refresh]);

  useKeyboard((key) => {
    if (!focused) return;

    if (key.name === "j" || key.name === "down") {
      setSelectedIndex((previous) =>
        Math.min(previous + 1, pendingReviews.length - 1),
      );
    }
    if (key.name === "k" || key.name === "up") {
      setSelectedIndex((previous) => Math.max(previous - 1, 0));
    }

    const selectedTask = pendingReviews[selectedIndex];
    if (!selectedTask) return;

    if (key.name === "a") {
      try {
        store.approveTask(selectedTask.id);
        setFeedback("approved: " + selectedTask.name);
        refresh();
        setSelectedIndex(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFeedback("error: " + message);
      }
    }

    if (key.name === "x") {
      try {
        store.rejectTask(selectedTask.id, "rejected via TUI");
        setFeedback("rejected: " + selectedTask.name);
        refresh();
        setSelectedIndex(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFeedback("error: " + message);
      }
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box flexDirection="row" paddingBottom={1}>
        <text fg={COLORS.textSecondary}>
          {pendingReviews.length +
            " pending  ·  j/k navigate  ·  a approve  ·  x reject"}
        </text>
      </box>

      {feedback && (
        <box paddingBottom={1}>
          <text fg={COLORS.cyan}>{feedback}</text>
        </box>
      )}

      {pendingReviews.length === 0 ? (
        <box padding={2}>
          <text fg={COLORS.textMuted}>no tasks awaiting review</text>
        </box>
      ) : (
        <scrollbox flexGrow={1} width="100%">
          {pendingReviews.map((task, index) => {
            const isSelected = index === selectedIndex;
            return (
              <box
                key={task.id}
                borderStyle={isSelected ? "rounded" : undefined}
                borderColor={isSelected ? COLORS.borderFocused : undefined}
                backgroundColor={isSelected ? COLORS.surface : undefined}
                flexDirection="column"
                padding={1}
                width="100%"
              >
                <box flexDirection="row">
                  <text fg={COLORS.yellow}>{"◉ "}</text>
                  <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>
                    {task.name}
                  </text>
                  <box flexGrow={1} />
                  <text fg={COLORS.textMuted}>{task.id.slice(0, 8)}</text>
                </box>
                <text fg={COLORS.textMuted}>
                  {"  trigger: " +
                    task.triggerType +
                    "  ·  priority: " +
                    task.priority}
                </text>
                {task.description && (
                  <text fg={COLORS.textMuted}>{"  " + task.description}</text>
                )}
              </box>
            );
          })}
        </scrollbox>
      )}
    </box>
  );
}
