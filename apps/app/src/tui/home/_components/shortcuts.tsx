import { useTheme } from "@/tui/_context/theme.tsx";

export const Shortcuts = () => {
  const { theme } = useTheme();

  return (
    <box flexDirection="row" gap={2} justifyContent="flex-end" width="100%" maxWidth={75}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} content="tab" />
        <text fg={theme.textMuted} content="agents" />
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} content="ctrl+p" />
        <text fg={theme.textMuted} content="commands" />
      </box>
    </box>
  );
};
