import { execSync } from "node:child_process";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useDaemonStatus } from "@/daemon/status.tsx";
import packageJson from "../../../../package.json";

const APPLICATION_VERSION = packageJson.version;

function getCurrentGitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

export const Footer = () => {
  const { theme } = useTheme();
  const daemonStatus = useDaemonStatus();

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const currentDirectory = process.cwd();
  const shortenedDirectory = currentDirectory.startsWith(homeDirectory)
    ? "~" + currentDirectory.slice(homeDirectory.length)
    : currentDirectory;
  const currentGitBranch = getCurrentGitBranch();
  const directoryWithBranch = currentGitBranch
    ? `${shortenedDirectory}:${currentGitBranch}`
    : shortenedDirectory;

  const daemonIndicator = formatDaemonIndicator(daemonStatus);

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      paddingLeft={0}
      paddingRight={0}
      paddingTop={1}
      paddingBottom={1}
      flexShrink={0}
    >
      <text fg={theme.textMuted} content={directoryWithBranch} />
      <box flexDirection="row" gap={2}>
        <text>
          <span fg={daemonStatus.connected ? theme.success : theme.error}>● </span>
          <span fg={theme.textMuted}>{daemonIndicator}</span>
        </text>
        <text fg={theme.textMuted} content={APPLICATION_VERSION} />
      </box>
    </box>
  );
};

function formatDaemonIndicator(status: {
  connected: boolean;
  activeWorkers: number;
  pendingTasks: number;
}): string {
  if (!status.connected) return "daemon offline";

  const parts = ["daemon"];
  if (status.activeWorkers > 0) parts.push(`${status.activeWorkers}w`);
  if (status.pendingTasks > 0) parts.push(`${status.pendingTasks}q`);

  return parts.join(" ");
}
