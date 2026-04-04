import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { type ChoiceContext } from "@opentui-ui/dialog/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { useTheme } from "@/tui/_context/theme.tsx";

type ThemePickerContentProperties = ChoiceContext<string>;

export const ThemePickerContent = ({ resolve }: ThemePickerContentProperties) => {
  const { theme, currentThemeName, availableThemes, setTheme } = useTheme();
  const terminalDimensions = useTerminalDimensions();
  const [searchQuery, setSearchQuery] = useState("");
  const initialIndex = useMemo(() => {
    const themes = availableThemes();
    const index = themes.indexOf(currentThemeName);
    return index >= 0 ? index : 0;
  }, []);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const scrollboxReference = useRef<ScrollBoxRenderable>(null);
  const initialThemeRef = useRef(currentThemeName);
  const confirmedRef = useRef(false);

  const allThemeNames = useMemo(() => availableThemes(), []);

  const filteredThemes = useMemo(() => {
    if (!searchQuery.trim()) return allThemeNames;
    const results = fuzzysort.go(searchQuery, allThemeNames, { limit: 20 });
    return results.map((result) => result.target);
  }, [allThemeNames, searchQuery]);

  const computedListMaxHeight = useMemo(() => {
    return Math.min(filteredThemes.length, Math.floor(terminalDimensions.height / 2) - 6);
  }, [filteredThemes.length, terminalDimensions.height]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const themeName = filteredThemes[index];
      if (themeName && scrollboxReference.current) {
        scrollboxReference.current.scrollChildIntoView(themeName);
      }
    },
    [filteredThemes],
  );

  const moveSelection = useCallback(
    (direction: number) => {
      setSelectedIndex((previousIndex) => {
        const totalOptions = filteredThemes.length;
        if (totalOptions === 0) return 0;
        let nextIndex = previousIndex + direction;
        if (nextIndex < 0) nextIndex = totalOptions - 1;
        if (nextIndex >= totalOptions) nextIndex = 0;
        scrollToIndex(nextIndex);
        return nextIndex;
      });
    },
    [filteredThemes.length, scrollToIndex],
  );

  useEffect(() => {
    scrollToIndex(initialIndex);
  }, []);

  useEffect(() => {
    const previewTheme = filteredThemes[selectedIndex];
    if (previewTheme) setTheme(previewTheme, false);
  }, [selectedIndex, filteredThemes]);

  useEffect(() => {
    return () => {
      if (!confirmedRef.current) {
        setTheme(initialThemeRef.current, false);
      }
    };
  }, []);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "up" || (keyEvent.ctrl && keyEvent.name === "p")) {
      moveSelection(-1);
    } else if (keyEvent.name === "down" || (keyEvent.ctrl && keyEvent.name === "n")) {
      moveSelection(1);
    } else if (keyEvent.name === "escape") {
      setTheme(initialThemeRef.current);
      resolve(undefined as unknown as string);
    } else if (keyEvent.name === "return") {
      const selectedTheme = filteredThemes[selectedIndex];
      if (selectedTheme) {
        confirmedRef.current = true;
        setTheme(selectedTheme);
        resolve(selectedTheme);
      }
    }
  });

  return (
    <box flexDirection="column" width="100%" paddingTop={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text attributes={TextAttributes.BOLD} fg={theme.text} content="Switch theme" />
          <text fg={theme.textMuted} content="esc" />
        </box>
      </box>
      <box paddingLeft={4} paddingRight={4} paddingTop={1}>
        <input
          focused
          placeholder="Search themes"
          marginBottom={1}
          onSubmit={() => {}}
          style={{
            backgroundColor: theme.backgroundElement,
            focusedBackgroundColor: theme.backgroundElement,
          }}
          onInput={(newValue: string) => {
            setSearchQuery(newValue);
            setSelectedIndex(0);
            const currentScrollbox = scrollboxReference.current;
            if (currentScrollbox) currentScrollbox.scrollBy(-currentScrollbox.scrollTop);
          }}
        />
      </box>
      <scrollbox
        ref={scrollboxReference}
        paddingLeft={1}
        paddingRight={1}
        maxHeight={computedListMaxHeight}
        scrollbarOptions={{ visible: false }}
      >
        {filteredThemes.map((themeName, optionIndex) => {
          const isSelected = optionIndex === selectedIndex;
          const isCurrent = themeName === initialThemeRef.current;

          return (
            <box
              key={themeName}
              id={themeName}
              flexDirection="row"
              justifyContent="space-between"
              paddingLeft={3}
              paddingRight={2}
              backgroundColor={isSelected ? theme.primary : undefined}
            >
              <box flexDirection="row" gap={1}>
                {isCurrent && (
                  <text fg={isSelected ? theme.background : theme.primary} content="●" />
                )}
                <text
                  attributes={isSelected ? TextAttributes.BOLD : undefined}
                  fg={isSelected ? theme.background : theme.text}
                  content={themeName}
                />
              </box>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
};
