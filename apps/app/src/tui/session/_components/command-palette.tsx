import { useState, useEffect, useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useCommands, type AutocompleteOption } from "@/tui/_context/commands.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";

interface CommandPaletteProperties {
  onClose: () => void;
}

const MAX_VISIBLE = 12;

export const CommandPalette = ({ onClose }: CommandPaletteProperties) => {
  const { theme } = useTheme();
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const allCommands = useMemo(() => commands.slashes(), [commands.slashes]);

  const filtered = useMemo(() => {
    if (!query) return allCommands;
    const results = fuzzysort.go(query, allCommands, {
      keys: [
        (opt: AutocompleteOption) => opt.display.trimEnd(),
        "description",
        (opt: AutocompleteOption) => opt.aliases?.join(" ") ?? "",
      ],
      threshold: -1000,
    });
    return results.map((r) => r.obj);
  }, [query, allCommands]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "escape") {
      onClose();
      return;
    }
    if (keyEvent.name === "return") {
      const selected = filtered[cursor];
      if (selected?.onSelect) {
        onClose();
        selected.onSelect();
      }
      return;
    }
    if (keyEvent.name === "up" || (keyEvent.ctrl && keyEvent.name === "p")) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (keyEvent.name === "down" || (keyEvent.ctrl && keyEvent.name === "n")) {
      setCursor((prev) => Math.min(filtered.length - 1, prev + 1));
      return;
    }
    if (keyEvent.name === "backspace") {
      setQuery((prev) => prev.slice(0, -1));
      return;
    }
    if (keyEvent.sequence && keyEvent.sequence.length === 1 && !keyEvent.ctrl && !keyEvent.meta) {
      setQuery((prev) => prev + keyEvent.sequence);
    }
  });

  const visibleCommands = filtered.slice(0, MAX_VISIBLE);

  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <box
        border={["left"] as const}
        borderColor={theme.accent}
        customBorderChars={{
          ...EMPTY_BORDER_CHARACTERS,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        backgroundColor={theme.backgroundElement}
      >
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingY={1}>
          <text fg={theme.text} content="Commands" attributes={TextAttributes.BOLD} />

          <box height={1} />

          <box flexDirection="row">
            <text fg={theme.accent} content="> " />
            <text fg={theme.text} content={query || " "} />
            <text fg={theme.accent} content="▎" />
          </box>

          <box height={1} />

          {visibleCommands.length === 0 ? (
            <text fg={theme.textMuted} content="  No matching commands" />
          ) : (
            visibleCommands.map((cmd, i) => {
              const isSelected = i === cursor;
              const isSkill = cmd.description?.startsWith("[skill]");
              return (
                <box key={cmd.display + i} flexDirection="row" gap={1}>
                  {isSelected ? (
                    <text fg="black" bg={theme.accent} content={` ${cmd.display.trimEnd()} `} />
                  ) : (
                    <text
                      fg={isSkill ? theme.textMuted : theme.text}
                      content={`  ${cmd.display.trimEnd()}`}
                    />
                  )}
                  {cmd.description && !isSelected && (
                    <text fg={theme.textMuted} content={cmd.description} />
                  )}
                </box>
              );
            })
          )}

          {filtered.length > MAX_VISIBLE && (
            <text fg={theme.textMuted} content={`  +${filtered.length - MAX_VISIBLE} more`} />
          )}
        </box>
      </box>

      <box flexDirection="row" gap={2} paddingLeft={3} marginTop={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} content="↑↓" />
          <text fg={theme.textMuted} content="navigate" />
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} content="enter" />
          <text fg={theme.textMuted} content="select" />
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} content="esc" />
          <text fg={theme.textMuted} content="close" />
        </box>
      </box>
    </box>
  );
};
