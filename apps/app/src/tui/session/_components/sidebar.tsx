import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { useState, useEffect } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useDaemonStatus } from "@/daemon/status.tsx";
import { TodoDisplay } from "@/tui/session/_components/todo.tsx";
import { FilesSidebar, type FileChange } from "@/tui/session/_components/files-sidebar.tsx";
import { Bus, Events } from "@/bus/index.ts";
import { getLspManager } from "@/lsp/manager.ts";

const SIDEBAR_WIDTH = 42;
const currentFileDirectory = dirname(fileURLToPath(import.meta.url));

const resolvedGitBranch = (() => {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) return "";
    return result.stdout?.trim() || "";
  } catch {
    return "";
  }
})();

const resolvedApplicationVersion = (() => {
  try {
    const packageJsonPath = resolve(currentFileDirectory, "../../../../package.json");
    const packageJsonContent = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version: string;
    };
    return packageJsonContent.version;
  } catch {
    return "0.1.0";
  }
})();

interface TodoSidebarItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

export interface SidebarProperties {
  sessionTitle: string;
  tokenCount: number;
  tokenPercentage: number;
  estimatedCost: number;
  agentName?: string;
  agentColor?: string;
  todos?: TodoSidebarItem[];
  modifiedFiles?: FileChange[];
}

export const Sidebar = ({
  sessionTitle,
  tokenCount,
  tokenPercentage,
  estimatedCost,
  agentName,
  agentColor,
  todos,
  modifiedFiles,
}: SidebarProperties) => {
  const { theme } = useTheme();
  const daemonStatus = useDaemonStatus();
  const [activeServers, setActiveServers] = useState<string[]>(
    () => getLspManager()?.getActiveServers() ?? [],
  );

  useEffect(() => {
    const subscription = Bus.subscribe(Events.Lsp.ServerStarted, () => {
      setActiveServers(getLspManager()?.getActiveServers() ?? []);
    });
    return () => subscription.unsubscribe();
  }, []);

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const currentDirectory = process.cwd();
  const shortenedDirectory = currentDirectory.startsWith(homeDirectory)
    ? "~" + currentDirectory.slice(homeDirectory.length)
    : currentDirectory;
  const gitBranch = resolvedGitBranch;

  const formattedTokenCount = tokenCount.toLocaleString();
  const formattedCost = `$${estimatedCost.toFixed(2)}`;
  const formattedPercentage = `${tokenPercentage}% used`;

  return (
    <box
      width={SIDEBAR_WIDTH}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      paddingLeft={2}
      paddingY={1}
    >
      <text fg={theme.text} attributes={TextAttributes.BOLD} content={sessionTitle} />

      {agentName && (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD} content="Agent" />
          <text fg={agentColor ?? theme.secondary} content={agentName} />
        </box>
      )}

      <box flexDirection="column" marginTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} content="Context" />
        <text fg={theme.textMuted} content={`${formattedTokenCount} tokens`} />
        <text fg={theme.textMuted} content={formattedPercentage} />
        <text fg={theme.textMuted} content={`${formattedCost} spent`} />
      </box>

      {modifiedFiles && modifiedFiles.length > 0 && <FilesSidebar files={modifiedFiles} />}

      <box flexDirection="column" marginTop={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} content="LSP" />
        {activeServers.length > 0 ? (
          activeServers.map((server) => (
            <text key={server}>
              <span fg={theme.success}>● </span>
              <span fg={theme.textMuted}>{server}</span>
            </text>
          ))
        ) : (
          <text fg={theme.textMuted} content="activates on first edit" />
        )}
      </box>

      {todos && todos.length > 0 && <TodoDisplay todos={todos} agentColor={agentColor} />}

      <box flexGrow={1} />

      <box flexDirection="column">
        <text
          fg={theme.textMuted}
          content={gitBranch ? `${shortenedDirectory}:${gitBranch}` : shortenedDirectory}
        />
        <text>
          <span fg={daemonStatus.connected ? theme.success : theme.error}>● </span>
          <span fg={theme.textMuted}>
            {daemonStatus.connected
              ? `daemon${daemonStatus.activeWorkers > 0 ? ` ${daemonStatus.activeWorkers}w` : ""}${daemonStatus.pendingTasks > 0 ? ` ${daemonStatus.pendingTasks}q` : ""}`
              : "daemon offline"}
          </span>
        </text>
        <text>
          <span fg={theme.accent}>• </span>
          <span fg={theme.textMuted}>Kraken {resolvedApplicationVersion}</span>
        </text>
      </box>
    </box>
  );
};
