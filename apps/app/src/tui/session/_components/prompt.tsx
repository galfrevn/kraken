import { useRef, useState, useMemo, useEffect } from "react";
import type { BoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useModels } from "@/tui/_context/models.tsx";
import {
  Autocomplete,
  type AutocompleteCallbackReference,
} from "@/tui/session/_components/autocomplete.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";
import { createFrames, createColors } from "@/tui/_ui/spinner.ts";
import { appendToHistory, createHistoryNavigator } from "@/tui/_ui/prompt-history.ts";

const SESSION_PROMPT_MAX_HEIGHT = 6;

const TEXTAREA_KEYBINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
];

interface SessionPromptProperties {
  onSubmit: (inputText: string) => void;
  disabled: boolean;
  isProcessing?: boolean;
  onInterrupt?: () => void;
  agentName: string;
  agentColor?: string;
  onToggleAgent?: () => void;
  undoAvailable?: boolean;
  redoAvailable?: boolean;
}

export const SessionPrompt = ({
  onSubmit,
  disabled,
  isProcessing,
  onInterrupt,
  agentName,
  agentColor,
  onToggleAgent,
  undoAvailable,
  redoAvailable,
}: SessionPromptProperties) => {
  const { theme } = useTheme();
  const { currentModelDisplayName, currentProviderDisplayName } = useModels();

  const [resetKey, setResetKey] = useState(0);
  const [currentTextareaValue, setCurrentTextareaValue] = useState("");
  const textareaReference = useRef<TextareaRenderable>(null);
  const anchorBoxReference = useRef<BoxRenderable>(null);
  const autocompleteCallbackReference = useRef<AutocompleteCallbackReference | null>(null);
  const historyRef = useRef(createHistoryNavigator());

  const handleTextareaSubmit = () => {
    if (autocompleteCallbackReference.current?.visible) return;
    const currentTextarea = textareaReference.current;
    if (!currentTextarea) return;
    const trimmedInputText = currentTextarea.plainText.trim();
    if (trimmedInputText && !disabled) {
      appendToHistory(trimmedInputText);
      historyRef.current.reset();
      onSubmit(trimmedInputText);
      currentTextarea.clear();
      setResetKey((previousKey) => previousKey + 1);
    }
  };

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "escape" && isProcessing && onInterrupt) {
      onInterrupt();
    }
    if (disabled || isProcessing) return;
    if (keyEvent.name === "up" && keyEvent.ctrl) {
      const entry = historyRef.current.move(-1, currentTextareaValue);
      if (entry !== null && textareaReference.current) {
        textareaReference.current.clear();
        textareaReference.current.insertText(entry);
      }
    }
    if (keyEvent.name === "down" && keyEvent.ctrl) {
      const entry = historyRef.current.move(1, currentTextareaValue);
      if (entry !== null && textareaReference.current) {
        textareaReference.current.clear();
        textareaReference.current.insertText(entry);
      }
    }
  });

  useEffect(() => {
    if (disabled) return;
    const refocusInterval = setInterval(() => {
      textareaReference.current?.focus();
    }, 100);
    return () => clearInterval(refocusInterval);
  }, [disabled]);

  const spinnerDefinition = useMemo(() => {
    const color = agentColor ?? theme.secondary;
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
    };
  }, [agentColor, theme.secondary]);

  const resolvedAgentColor = agentColor ?? theme.secondary;
  const borderHighlightColor = disabled ? theme.border : resolvedAgentColor;

  return (
    <box flexShrink={0} flexDirection="column">
      <Autocomplete
        textareaValue={currentTextareaValue}
        anchorReference={anchorBoxReference}
        textareaReference={textareaReference}
        autocompleteCallbackReference={autocompleteCallbackReference}
      />
      <box
        ref={anchorBoxReference}
        border={["left"] as const}
        customBorderChars={{
          ...EMPTY_BORDER_CHARACTERS,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        borderColor={borderHighlightColor}
      >
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          flexDirection="column"
          flexShrink={0}
          flexGrow={1}
          backgroundColor={theme.backgroundElement}
        >
          <textarea
            key={resetKey}
            ref={textareaReference}
            placeholder=""
            minHeight={1}
            maxHeight={SESSION_PROMPT_MAX_HEIGHT}
            onSubmit={handleTextareaSubmit}
            focused={!disabled}
            backgroundColor={theme.backgroundElement}
            focusedBackgroundColor={theme.backgroundElement}
            textColor={theme.text}
            focusedTextColor={theme.text}
            keyBindings={TEXTAREA_KEYBINDINGS}
            onContentChange={() => {
              const latestTextValue = textareaReference.current?.plainText ?? "";
              setCurrentTextareaValue(latestTextValue);
              autocompleteCallbackReference.current?.onInput(latestTextValue);
            }}
            onKeyDown={(keyEvent: unknown) => {
              if (disabled) {
                (keyEvent as { preventDefault: () => void }).preventDefault();
                return;
              }
              const typedEvent = keyEvent as import("@opentui/core").KeyEvent & {
                preventDefault: () => void;
              };
              if (
                typedEvent.name === "tab" &&
                !isProcessing &&
                !autocompleteCallbackReference.current?.visible &&
                onToggleAgent
              ) {
                typedEvent.preventDefault();
                onToggleAgent();
                return;
              }
              autocompleteCallbackReference.current?.onKeyDown(typedEvent);
            }}
          />
          <box flexDirection="row" gap={2} paddingTop={1} flexShrink={0}>
            <text fg={resolvedAgentColor} content={agentName} />
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content={currentModelDisplayName} />
              <text fg={theme.textMuted} content={currentProviderDisplayName} />
            </box>
          </box>
        </box>
      </box>
      <box
        height={1}
        border={["left"] as const}
        borderColor={borderHighlightColor}
        customBorderChars={{
          ...EMPTY_BORDER_CHARACTERS,
          vertical: "╹",
        }}
      >
        <box
          height={1}
          border={["bottom"] as const}
          borderColor={theme.backgroundElement}
          customBorderChars={{
            ...EMPTY_BORDER_CHARACTERS,
            horizontal: "▀",
          }}
        />
      </box>
      <box
        flexDirection="row"
        justifyContent={isProcessing ? "space-between" : "flex-end"}
        paddingBottom={1}
        gap={2}
      >
        {isProcessing ? (
          <>
            <box flexDirection="row" gap={1} marginLeft={1}>
              <spinner
                color={spinnerDefinition.color}
                frames={spinnerDefinition.frames}
                interval={40}
              />
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="esc" />
              <text fg={theme.textMuted} content="interrupt" />
            </box>
          </>
        ) : (
          <>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="tab" />
              <text fg={theme.textMuted} content="agents" />
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="ctrl+p" />
              <text fg={theme.textMuted} content="commands" />
            </box>
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
          </>
        )}
      </box>
    </box>
  );
};
