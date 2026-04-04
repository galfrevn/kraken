import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type {
  BoxRenderable,
  TextareaRenderable,
  ScrollBoxRenderable,
  KeyEvent,
} from "@opentui/core";
import fuzzysort from "fuzzysort";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import { useCommands, type AutocompleteOption } from "@/tui/_context/commands.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";

const POSITION_POLL_INTERVAL_MILLISECONDS = 50;
const AUTOCOMPLETE_MAX_RESULTS = 10;
const EXACT_PREFIX_SCORE_MULTIPLIER = 2;
const AUTOCOMPLETE_POPUP_Z_INDEX = 100;
const FILE_SEARCH_DEBOUNCE_MILLISECONDS = 100;

export interface AutocompleteCallbackReference {
  onInput: (currentInputValue: string) => void;
  onKeyDown: (keyEvent: KeyEvent) => void;
  visible: false | "/" | "@";
}

interface AutocompleteProperties {
  textareaValue: string;
  anchorReference: React.RefObject<BoxRenderable | null>;
  textareaReference: React.RefObject<TextareaRenderable | null>;
  autocompleteCallbackReference: React.MutableRefObject<AutocompleteCallbackReference | null>;
}

interface AutocompleteState {
  triggerCharacterIndex: number;
  selectedItemIndex: number;
  isVisible: false | "/" | "@";
  inputMode: "keyboard" | "mouse";
}

export const Autocomplete = ({
  textareaValue,
  anchorReference,
  textareaReference,
  autocompleteCallbackReference,
}: AutocompleteProperties) => {
  const { theme } = useTheme();
  const sdk = useSdk();
  const commands = useCommands();
  const scrollboxReference = useRef<ScrollBoxRenderable>(null);
  const [fileOptions, setFileOptions] = useState<AutocompleteOption[]>([]);
  const fileSearchAbortRef = useRef<AbortController | null>(null);

  const [autocompleteState, setAutocompleteState] = useState<AutocompleteState>({
    triggerCharacterIndex: 0,
    selectedItemIndex: 0,
    isVisible: false,
    inputMode: "keyboard",
  });

  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0, width: 0 });
  const [searchQuery, setSearchQuery] = useState("");

  const filterText = useMemo(() => {
    if (!autocompleteState.isVisible) return "";
    const currentTextarea = textareaReference.current;
    if (!currentTextarea) return "";
    return currentTextarea.getTextRange(
      autocompleteState.triggerCharacterIndex + 1,
      currentTextarea.cursorOffset,
    );
  }, [autocompleteState.isVisible, autocompleteState.triggerCharacterIndex, textareaValue]);

  useEffect(() => {
    setSearchQuery(filterText || "");
  }, [filterText]);

  useEffect(() => {
    if (autocompleteState.isVisible !== "@") {
      setFileOptions([]);
      return;
    }

    fileSearchAbortRef.current?.abort();

    const debounceTimer = setTimeout(() => {
      const abortController = new AbortController();
      fileSearchAbortRef.current = abortController;

      const queryParam = encodeURIComponent(searchQuery);
      sdk.client
        .fetch(`/find/files?query=${queryParam}`, { signal: abortController.signal })
        .then(async (response) => {
          if (!response.ok || abortController.signal.aborted) return;
          const data = (await response.json()) as { files: string[] };
          setFileOptions(
            data.files.map((filePath) => ({
              display: `@${filePath}`,
              value: filePath,
              description: "",
            })),
          );
        })
        .catch(() => {});
    }, FILE_SEARCH_DEBOUNCE_MILLISECONDS);

    return () => {
      clearTimeout(debounceTimer);
      fileSearchAbortRef.current?.abort();
    };
  }, [autocompleteState.isVisible, searchQuery]);

  useEffect(() => {
    setAutocompleteState((previousState) => ({
      ...previousState,
      selectedItemIndex: 0,
      inputMode: "keyboard",
    }));
  }, [filterText]);

  useEffect(() => {
    if (!autocompleteState.isVisible) return;

    let lastKnownPosition = { x: 0, y: 0, width: 0 };
    const positionPollingInterval = setInterval(() => {
      const anchorElement = anchorReference.current;
      if (!anchorElement) return;
      if (
        anchorElement.x !== lastKnownPosition.x ||
        anchorElement.y !== lastKnownPosition.y ||
        anchorElement.width !== lastKnownPosition.width
      ) {
        lastKnownPosition = { x: anchorElement.x, y: anchorElement.y, width: anchorElement.width };
        const parentElement = anchorElement.parent;
        const parentXPosition = parentElement?.x ?? 0;
        const parentYPosition = parentElement?.y ?? 0;
        setPopupPosition({
          x: anchorElement.x - parentXPosition,
          y: anchorElement.y - parentYPosition,
          width: anchorElement.width,
        });
      }
    }, POSITION_POLL_INTERVAL_MILLISECONDS);

    return () => clearInterval(positionPollingInterval);
  }, [autocompleteState.isVisible]);

  const commandOptions = useMemo((): AutocompleteOption[] => {
    return commands.slashes();
  }, [commands.slashes]);

  const filteredOptions = useMemo((): AutocompleteOption[] => {
    if (!autocompleteState.isVisible) return [];

    if (autocompleteState.isVisible === "@") {
      return fileOptions;
    }

    if (!searchQuery) return commandOptions;

    const fuzzySearchResults = fuzzysort.go(searchQuery, commandOptions, {
      keys: [
        (option: AutocompleteOption) => (option.value ?? option.display).trimEnd(),
        "description",
        (option: AutocompleteOption) => option.aliases?.join(" ") ?? "",
      ],
      limit: AUTOCOMPLETE_MAX_RESULTS,
      scoreFn: (objectResults) => {
        const displayResult = objectResults[0];
        let score = objectResults.score;
        if (displayResult && displayResult.target.startsWith("/" + searchQuery)) {
          score *= EXACT_PREFIX_SCORE_MULTIPLIER;
        }
        return score;
      },
    });

    return fuzzySearchResults.map((result) => result.obj);
  }, [autocompleteState.isVisible, searchQuery, commandOptions, fileOptions]);

  const computedPopupHeight = useMemo(() => {
    const itemCount = filteredOptions.length || 1;
    if (!autocompleteState.isVisible) return Math.min(10, itemCount);
    const anchorElement = anchorReference.current;
    const availableSpaceAbove = anchorElement?.y ?? 1;
    return Math.min(10, itemCount, Math.max(1, availableSpaceAbove));
  }, [filteredOptions.length, autocompleteState.isVisible]);

  const moveSelection = useCallback(
    (direction: -1 | 1) => {
      setAutocompleteState((previousState) => {
        if (!previousState.isVisible) return previousState;
        const optionCount = filteredOptions.length;
        if (!optionCount) return previousState;
        let nextIndex = previousState.selectedItemIndex + direction;
        if (nextIndex < 0) nextIndex = optionCount - 1;
        if (nextIndex >= optionCount) nextIndex = 0;

        const currentScrollbox = scrollboxReference.current;
        if (currentScrollbox) {
          const viewportHeight = Math.min(computedPopupHeight, optionCount);
          const scrollBottom = currentScrollbox.scrollTop + viewportHeight;
          if (nextIndex < currentScrollbox.scrollTop) {
            currentScrollbox.scrollBy(nextIndex - currentScrollbox.scrollTop);
          } else if (nextIndex + 1 > scrollBottom) {
            currentScrollbox.scrollBy(nextIndex + 1 - scrollBottom);
          }
        }

        return { ...previousState, selectedItemIndex: nextIndex, inputMode: "keyboard" };
      });
    },
    [filteredOptions.length, computedPopupHeight],
  );

  const moveSelectionTo = useCallback(
    (targetIndex: number) => {
      setAutocompleteState((previousState) => {
        const currentScrollbox = scrollboxReference.current;
        if (currentScrollbox) {
          const optionCount = filteredOptions.length;
          const viewportHeight = Math.min(computedPopupHeight, optionCount);
          const scrollBottom = currentScrollbox.scrollTop + viewportHeight;
          if (targetIndex < currentScrollbox.scrollTop) {
            currentScrollbox.scrollBy(targetIndex - currentScrollbox.scrollTop);
          } else if (targetIndex + 1 > scrollBottom) {
            currentScrollbox.scrollBy(targetIndex + 1 - scrollBottom);
          }
        }
        return { ...previousState, selectedItemIndex: targetIndex };
      });
    },
    [filteredOptions.length, computedPopupHeight],
  );

  const showAutocomplete = useCallback((mode: "/" | "@") => {
    const currentTextarea = textareaReference.current;
    if (!currentTextarea) return;
    setAutocompleteState({
      isVisible: mode,
      triggerCharacterIndex: currentTextarea.cursorOffset,
      selectedItemIndex: 0,
      inputMode: "keyboard",
    });
  }, []);

  const hideAutocomplete = useCallback(() => {
    const currentTextarea = textareaReference.current;
    if (currentTextarea && autocompleteState.isVisible === "/") {
      const currentText = currentTextarea.plainText;
      if (currentText.startsWith("/") && !currentText.endsWith(" ")) {
        const logicalCursor = currentTextarea.logicalCursor;
        currentTextarea.deleteRange(0, 0, logicalCursor.row, logicalCursor.col);
      }
    }
    setAutocompleteState({
      triggerCharacterIndex: 0,
      selectedItemIndex: 0,
      isVisible: false,
      inputMode: "keyboard",
    });
  }, [autocompleteState.isVisible]);

  const selectCurrentItem = useCallback(() => {
    const selectedOption = filteredOptions[autocompleteState.selectedItemIndex];
    if (!selectedOption) return;

    const currentTextarea = textareaReference.current;
    if (!currentTextarea) return;

    if (autocompleteState.isVisible === "@") {
      const filePath = selectedOption.value ?? selectedOption.display.replace(/^@/, "");
      const currentText = currentTextarea.plainText;
      const beforeTrigger = currentText.slice(0, autocompleteState.triggerCharacterIndex);
      const afterCursor = currentText.slice(currentTextarea.cursorOffset);
      const newFullText = `${beforeTrigger}@${filePath} ${afterCursor}`;

      const logicalCursor = currentTextarea.logicalCursor;
      currentTextarea.deleteRange(0, 0, logicalCursor.row, logicalCursor.col + afterCursor.length);
      currentTextarea.insertText(newFullText);
      setAutocompleteState({
        triggerCharacterIndex: 0,
        selectedItemIndex: 0,
        isVisible: false,
        inputMode: "keyboard",
      });
      return;
    }

    if (selectedOption.onSelect) {
      hideAutocomplete();
      selectedOption.onSelect();
    } else {
      const commandName = selectedOption.display.trimEnd();
      const newText = commandName + " ";
      const logicalCursor = currentTextarea.logicalCursor;
      currentTextarea.deleteRange(0, 0, logicalCursor.row, logicalCursor.col);
      currentTextarea.insertText(newText);
      hideAutocomplete();
    }
  }, [
    filteredOptions,
    autocompleteState.selectedItemIndex,
    autocompleteState.isVisible,
    autocompleteState.triggerCharacterIndex,
    hideAutocomplete,
  ]);

  useEffect(() => {
    autocompleteCallbackReference.current = {
      get visible() {
        return autocompleteState.isVisible;
      },

      onInput(currentInputValue: string) {
        if (autocompleteState.isVisible) {
          const currentTextarea = textareaReference.current;
          if (!currentTextarea) return;

          const textSinceTrigger = currentTextarea.getTextRange(
            autocompleteState.triggerCharacterIndex,
            currentTextarea.cursorOffset,
          );

          if (
            currentTextarea.cursorOffset <= autocompleteState.triggerCharacterIndex ||
            (autocompleteState.isVisible === "/" && textSinceTrigger.match(/\s/)) ||
            (autocompleteState.isVisible === "/" && currentInputValue.match(/^\S+\s+\S+\s*$/)) ||
            (autocompleteState.isVisible === "@" && textSinceTrigger.match(/\s/))
          ) {
            hideAutocomplete();
          }
          return;
        }

        const currentTextarea = textareaReference.current;
        if (!currentTextarea) return;
        const currentCursorOffset = currentTextarea.cursorOffset;
        if (currentCursorOffset === 0) return;

        if (
          currentInputValue.startsWith("/") &&
          !currentInputValue.slice(0, currentCursorOffset).match(/\s/)
        ) {
          setAutocompleteState({
            isVisible: "/",
            triggerCharacterIndex: 0,
            selectedItemIndex: 0,
            inputMode: "keyboard",
          });
          return;
        }

        const textUpToCursor = currentInputValue.slice(0, currentCursorOffset);
        const lastAtIndex = textUpToCursor.lastIndexOf("@");
        if (lastAtIndex >= 0) {
          const charBeforeAt = lastAtIndex > 0 ? textUpToCursor[lastAtIndex - 1] : " ";
          const textAfterAt = textUpToCursor.slice(lastAtIndex + 1);
          if (
            (charBeforeAt === " " || charBeforeAt === "\n" || lastAtIndex === 0) &&
            !textAfterAt.includes(" ")
          ) {
            setAutocompleteState({
              isVisible: "@",
              triggerCharacterIndex: lastAtIndex,
              selectedItemIndex: 0,
              inputMode: "keyboard",
            });
          }
        }
      },

      onKeyDown(keyEvent: KeyEvent) {
        if (autocompleteState.isVisible) {
          const keyName = keyEvent.name?.toLowerCase();
          const isControlOnly = keyEvent.ctrl && !keyEvent.meta && !keyEvent.shift;
          const isNavigateUp = keyName === "up" || (isControlOnly && keyName === "p");
          const isNavigateDown = keyName === "down" || (isControlOnly && keyName === "n");

          if (isNavigateUp) {
            moveSelection(-1);
            keyEvent.preventDefault();
            return;
          }
          if (isNavigateDown) {
            moveSelection(1);
            keyEvent.preventDefault();
            return;
          }
          if (keyName === "escape") {
            hideAutocomplete();
            keyEvent.preventDefault();
            return;
          }
          if (keyName === "return") {
            selectCurrentItem();
            keyEvent.preventDefault();
            return;
          }
          if (keyName === "tab") {
            selectCurrentItem();
            keyEvent.preventDefault();
            return;
          }
        }

        if (!autocompleteState.isVisible) {
          if (keyEvent.name === "/") {
            const currentTextarea = textareaReference.current;
            if (currentTextarea && currentTextarea.cursorOffset === 0) {
              showAutocomplete("/");
            }
          }
        }
      },
    };
  }, [
    autocompleteState.isVisible,
    autocompleteState.triggerCharacterIndex,
    autocompleteState.selectedItemIndex,
    moveSelection,
    hideAutocomplete,
    selectCurrentItem,
    showAutocomplete,
  ]);

  return (
    <box
      visible={autocompleteState.isVisible !== false}
      position="absolute"
      top={popupPosition.y - computedPopupHeight}
      left={popupPosition.x}
      width={popupPosition.width}
      zIndex={AUTOCOMPLETE_POPUP_Z_INDEX}
      border={["left", "right"] as const}
      customBorderChars={{
        ...EMPTY_BORDER_CHARACTERS,
        vertical: "┃",
      }}
      borderColor={theme.border}
    >
      <scrollbox
        ref={scrollboxReference}
        backgroundColor={theme.backgroundMenu}
        height={computedPopupHeight}
        scrollbarOptions={{ visible: false }}
      >
        {filteredOptions.length === 0 ? (
          <box paddingLeft={1} paddingRight={1}>
            <text fg={theme.textMuted} content="No matching items" />
          </box>
        ) : (
          filteredOptions.map((option, itemIndex) => (
            <box
              key={option.display}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                itemIndex === autocompleteState.selectedItemIndex ? theme.primary : undefined
              }
              flexDirection="row"
              onMouseMove={() => {
                setAutocompleteState((previousState) => ({ ...previousState, inputMode: "mouse" }));
              }}
              onMouseOver={() => {
                if (autocompleteState.inputMode !== "mouse") return;
                moveSelectionTo(itemIndex);
              }}
              onMouseDown={() => {
                setAutocompleteState((previousState) => ({ ...previousState, inputMode: "mouse" }));
                moveSelectionTo(itemIndex);
              }}
              onMouseUp={() => selectCurrentItem()}
            >
              <text
                fg={
                  itemIndex === autocompleteState.selectedItemIndex ? theme.background : theme.text
                }
                flexShrink={0}
                content={option.display}
              />
              {option.description && (
                <text
                  fg={
                    itemIndex === autocompleteState.selectedItemIndex
                      ? theme.background
                      : theme.textMuted
                  }
                  wrapMode="none"
                  content={option.description}
                />
              )}
            </box>
          ))
        )}
      </scrollbox>
    </box>
  );
};
