import { useState } from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/tui/_context/theme.tsx";

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

interface FilesSidebarProperties {
  files: FileChange[];
}

const COLLAPSE_THRESHOLD = 3;

export const FilesSidebar = ({ files }: FilesSidebarProperties) => {
  const { theme } = useTheme();
  const [open, setOpen] = useState(true);

  if (files.length === 0) return null;

  const collapsible = files.length > COLLAPSE_THRESHOLD;
  const visibleFiles = collapsible && !open ? files.slice(0, COLLAPSE_THRESHOLD) : files;
  const arrow = open ? "▼" : "▶";

  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row" gap={1} onMouseUp={collapsible ? () => setOpen(!open) : undefined}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} content="Modified Files" />
        <text fg={theme.textMuted} content={`(${files.length})`} />
        {collapsible && <text fg={theme.textMuted} content={arrow} />}
      </box>

      {visibleFiles.map((file) => {
        const name = file.path.length > 30 ? "…" + file.path.slice(-29) : file.path;
        return (
          <box key={file.path} flexDirection="row" justifyContent="space-between">
            <text fg={theme.textMuted} content={name} />
            <box flexDirection="row" gap={1}>
              {file.additions > 0 && <text fg={theme.success} content={`+${file.additions}`} />}
              {file.deletions > 0 && <text fg={theme.error} content={`-${file.deletions}`} />}
            </box>
          </box>
        );
      })}

      {collapsible && !open && (
        <text fg={theme.textMuted} content={`  +${files.length - COLLAPSE_THRESHOLD} more`} />
      )}
    </box>
  );
};
