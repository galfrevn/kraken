import { useMemo } from "react";
import { useTheme } from "@/tui/_context/theme.tsx";

type TipSegment = { text: string; highlighted: boolean };

function parseTipHighlights(tipText: string): TipSegment[] {
  const segments: TipSegment[] = [];
  const highlightPattern = /\{highlight\}(.*?)\{\/highlight\}/g;
  let lastMatchEndIndex = 0;

  for (const match of tipText.matchAll(highlightPattern)) {
    const matchStartIndex = match.index ?? 0;
    if (matchStartIndex > lastMatchEndIndex) {
      segments.push({
        text: tipText.slice(lastMatchEndIndex, matchStartIndex),
        highlighted: false,
      });
    }
    segments.push({ text: match[1] ?? "", highlighted: true });
    lastMatchEndIndex = matchStartIndex + match[0].length;
  }

  if (lastMatchEndIndex < tipText.length) {
    segments.push({ text: tipText.slice(lastMatchEndIndex), highlighted: false });
  }

  return segments;
}

const KRAKEN_TIPS = [
  "Use {highlight}kraken task create{/highlight} to queue a new task for the daemon",
  "Use {highlight}kraken task list{/highlight} to see pending and running tasks",
  "Use {highlight}kraken daemon status{/highlight} to check if the daemon is running",
  "Use {highlight}kraken config show{/highlight} to view current configuration",
  "Use {highlight}kraken stats{/highlight} to see token usage and costs",
  "Use {highlight}kraken init{/highlight} to set up a new project with the wizard",
  "Use {highlight}kraken logs --follow{/highlight} to stream daemon logs in real-time",
  "Use {highlight}kraken trigger list{/highlight} to see configured automation triggers",
  "Type {highlight}@{/highlight} to reference files by name and add them to context",
  "Use {highlight}/clear{/highlight} to reset the conversation history",
  "Press {highlight}Shift+Enter{/highlight} to add newlines in the prompt",
  "Press {highlight}Ctrl+C{/highlight} to cancel the current operation",
  "Use {highlight}kraken clean{/highlight} to remove old worktrees and tasks",
  "Use {highlight}kraken config set{/highlight} to change configuration values",
  "Use {highlight}kraken task retry{/highlight} to re-run a failed task",
  "Configure cron triggers in {highlight}kraken.jsonc{/highlight} for scheduled tasks",
  "Use {highlight}--json{/highlight} flag on any CLI command for machine-readable output",
  "Add custom themes to {highlight}~/.kraken/themes/{/highlight} as JSON files",
  "Use {highlight}kraken notification test{/highlight} to verify alert channels",
  "The daemon binds to {highlight}localhost only{/highlight} for security",
  "Use {highlight}kraken daemon start{/highlight} to run the daemon in background",
];

export const Tip = () => {
  const { theme } = useTheme();

  const randomTipSegments = useMemo(() => {
    const randomIndex = Math.floor(Math.random() * KRAKEN_TIPS.length);
    return parseTipHighlights(KRAKEN_TIPS[randomIndex] ?? "");
  }, []);

  return (
    <box flexDirection="row" maxWidth={75} width="100%" justifyContent="center">
      <text fg={theme.warning} content="● Tip " />
      <text>
        {randomTipSegments.map((segment, segmentIndex) => (
          <span key={segmentIndex} fg={segment.highlighted ? theme.text : theme.textMuted}>
            {segment.text}
          </span>
        ))}
      </text>
    </box>
  );
};
