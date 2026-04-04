import { useMemo } from "react";
import { useTheme } from "@/tui/_context/theme.tsx";

const LOGO_LINES = [
  "█░░█ █▀▀▄ ▄▀▀▄ █░░█ █▀▀▀ █▀▀▄   █▀▀▀ █▀▀█ █▀▀▄ █▀▀▀",
  "█▀▀░ █▀▀░ █▀▀█ █▀▀░ █▀▀░ █░░█   █░░░ █░░█ █░░█ █▀▀░",
  "█░░█ █░░█ █░░█ █░░█ ████ █  █   ████ ████ ████ ████",
];

const TIPS = [
  "Use {h}kraken task create{/h} to queue a new task for the daemon",
  "Use {h}kraken task list{/h} to see pending and running tasks",
  "Use {h}kraken daemon status{/h} to check if the daemon is running",
  "Use {h}kraken stats{/h} to see token usage and costs",
  "Type {h}@{/h} to reference files by name and add them to context",
  "Press {h}Shift+Enter{/h} to add newlines in the prompt",
  "Use {h}kraken logs --follow{/h} to stream daemon logs in real-time",
  "Configure cron triggers in {h}kraken.jsonc{/h} for scheduled tasks",
  "Use {h}kraken clean{/h} to remove old worktrees and tasks",
  "Use {h}kraken widget setup{/h} to configure the iOS widget",
];

function parseTip(text: string): Array<{ text: string; highlighted: boolean }> {
  const segments: Array<{ text: string; highlighted: boolean }> = [];
  const pattern = /\{h\}(.*?)\{\/h\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start), highlighted: false });
    segments.push({ text: match[1] ?? "", highlighted: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), highlighted: false });
  return segments;
}

export const EmptyState = () => {
  const { theme } = useTheme();

  const tip = useMemo(() => {
    const idx = Math.floor(Math.random() * TIPS.length);
    return parseTip(TIPS[idx] ?? "");
  }, []);

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <box flexDirection="column" alignItems="center">
        {LOGO_LINES.map((line, i) => (
          <text key={i} fg={theme.accent} content={line} />
        ))}
      </box>

      <box height={2} />

      <text fg={theme.textMuted} content="Ask anything to get started." />

      <box height={1} />

      <box flexDirection="row">
        <text fg={theme.warning} content="tip " />
        <text>
          {tip.map((s, i) => (
            <span key={i} fg={s.highlighted ? theme.text : theme.textMuted}>
              {s.text}
            </span>
          ))}
        </text>
      </box>
    </box>
  );
};
