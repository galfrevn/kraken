import { useTheme } from "@/tui/_context/theme.tsx";
import { useDaemonStatus } from "@/daemon/status.tsx";
import { getLspManager } from "@/lsp/manager.ts";

interface StatusFooterProperties {
  undoAvailable: boolean;
  redoAvailable: boolean;
  revertedCount: number;
}

export const StatusFooter = ({
  undoAvailable,
  redoAvailable,
  revertedCount,
}: StatusFooterProperties) => {
  const { theme } = useTheme();
  const daemonStatus = useDaemonStatus();

  const lspCount = getLspManager()?.getActiveServers().length ?? 0;

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const currentDirectory = process.cwd();
  const shortenedDirectory = currentDirectory.startsWith(homeDirectory)
    ? "~" + currentDirectory.slice(homeDirectory.length)
    : currentDirectory;

  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingX={1}>
      <text fg={theme.textMuted} content={shortenedDirectory} />

      <box flexDirection="row" gap={2}>
        {revertedCount > 0 && (
          <box flexDirection="row" gap={1}>
            <text fg={theme.warning} content="△" />
            <text fg={theme.textMuted} content={`${revertedCount} reverted`} />
          </box>
        )}

        {undoAvailable && (
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} content="ctrl+z" />
            <text fg={theme.textMuted} content="undo" />
          </box>
        )}

        {redoAvailable && (
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} content="ctrl+y" />
            <text fg={theme.textMuted} content="redo" />
          </box>
        )}

        {lspCount > 0 && (
          <text>
            <span fg={theme.success}>● </span>
            <span fg={theme.textMuted}>{`${lspCount} LSP`}</span>
          </text>
        )}

        <text>
          <span fg={daemonStatus.connected ? theme.success : theme.error}>● </span>
          <span fg={theme.textMuted}>{daemonStatus.connected ? "daemon" : "offline"}</span>
        </text>
      </box>
    </box>
  );
};
