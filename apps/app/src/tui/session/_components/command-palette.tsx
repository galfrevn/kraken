import { useState, useMemo, useRef, useCallback } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useCommands, type AutocompleteOption } from "@/tui/_context/commands.tsx";

interface CommandPaletteContentProperties {
  resolve: (value: string | undefined) => void;
}

export const CommandPaletteContent = ({ resolve }: CommandPaletteContentProperties) => {
  const { theme } = useTheme();
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const scrollboxReference = useRef<ScrollBoxRenderable>(null);

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

  const moveSelection = useCallback(
    (direction: number) => {
      setCursor((prev) => {
        const total = filtered.length;
        if (total === 0) return 0;
        let next = prev + direction;
        if (next < 0) next = total - 1;
        if (next >= total) next = 0;

        const currentScrollbox = scrollboxReference.current;
        if (currentScrollbox) {
          const targetCmd = filtered[next];
          if (targetCmd) {
            currentScrollbox.scrollChildIntoView(`cmd-${next}`);
          }
        }

        return next;
      });
    },
    [filtered.length],
  );

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "up" || (keyEvent.ctrl && keyEvent.name === "p")) {
      moveSelection(-1);
    } else if (keyEvent.name === "down" || (keyEvent.ctrl && keyEvent.name === "n")) {
      moveSelection(1);
    } else if (keyEvent.name === "escape") {
      resolve(undefined);
    } else if (keyEvent.name === "return") {
      const selected = filtered[cursor];
      if (selected) {
        resolve(selected.value);
      }
    }
  });

  return (
    <box flexDirection="column" width="100%" paddingY={1}>
      <box paddingX={4}>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text attributes={TextAttributes.BOLD} fg={theme.text} content="Commands" />
          <text fg={theme.textMuted} content="esc close" />
        </box>
      </box>
      <box paddingX={4} paddingTop={1}>
        <input
          focused
          placeholder="Search commands..."
          marginBottom={1}
          onSubmit={() => {}}
          style={{
            backgroundColor: theme.backgroundElement,
            focusedBackgroundColor: theme.backgroundElement,
          }}
          onInput={(newValue: string) => {
            setQuery(newValue);
            setCursor(0);
            const s = scrollboxReference.current;
            if (s) s.scrollBy(-s.scrollTop);
          }}
        />
      </box>
      <scrollbox
        ref={scrollboxReference}
        paddingX={1}
        maxHeight={20}
        scrollbarOptions={{ visible: false }}
      >
        {filtered.length === 0 ? (
          <box paddingLeft={3}>
            <text fg={theme.textMuted} content="No matching commands" />
          </box>
        ) : (
          filtered.map((cmd, i) => {
            const isSelected = i === cursor;
            const isSkill = cmd.description?.startsWith("[skill]");
            return (
              <box key={cmd.display + i} id={`cmd-${i}`} flexDirection="row" gap={1}>
                {isSelected ? (
                  <text
                    fg={theme.background}
                    bg={theme.accent}
                    content={` ${cmd.display.trimEnd()} `}
                    attributes={TextAttributes.BOLD}
                  />
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
      </scrollbox>
      <box paddingX={4} paddingTop={1} flexDirection="row" gap={2}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} content="↑↓" />
          <text fg={theme.textMuted} content="navigate" />
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} content="enter" />
          <text fg={theme.textMuted} content="select" />
        </box>
      </box>
    </box>
  );
};
