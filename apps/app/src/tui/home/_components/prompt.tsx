import { useRef, useState } from "react";
import type { BoxRenderable, TextareaRenderable } from "@opentui/core";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useModels } from "@/tui/_context/models.tsx";
import {
  Autocomplete,
  type AutocompleteCallbackReference,
} from "@/tui/session/_components/autocomplete.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";

const TEXTAREA_KEYBINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
];

interface PromptProperties {
  onSubmit: (inputText: string) => void;
  agentName: string;
  agentColor?: string;
  onToggleAgent?: () => void;
}

export const Prompt = ({ onSubmit, agentName, agentColor, onToggleAgent }: PromptProperties) => {
  const { theme } = useTheme();
  const { currentModelDisplayName, currentProviderDisplayName } = useModels();

  const [resetKey, setResetKey] = useState(0);
  const [currentTextareaValue, setCurrentTextareaValue] = useState("");
  const textareaReference = useRef<TextareaRenderable>(null);
  const anchorBoxReference = useRef<BoxRenderable>(null);
  const autocompleteCallbackReference = useRef<AutocompleteCallbackReference | null>(null);

  const handleTextareaSubmit = () => {
    if (autocompleteCallbackReference.current?.visible) return;
    const currentTextarea = textareaReference.current;
    if (!currentTextarea) return;
    const trimmedInputText = currentTextarea.plainText.trim();
    if (trimmedInputText) {
      onSubmit(trimmedInputText);
      currentTextarea.clear();
      setResetKey((previousKey) => previousKey + 1);
    }
  };

  return (
    <box flexShrink={0} flexDirection="column" width="100%" maxWidth={75}>
      <Autocomplete
        textareaValue={currentTextareaValue}
        anchorReference={anchorBoxReference}
        textareaReference={textareaReference}
        autocompleteCallbackReference={autocompleteCallbackReference}
      />
      <box
        ref={anchorBoxReference}
        border={["left"] as const}
        borderColor={agentColor ?? theme.secondary}
        customBorderChars={{
          ...EMPTY_BORDER_CHARACTERS,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        backgroundColor={theme.backgroundElement}
      >
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          flexDirection="column"
          flexShrink={0}
          flexGrow={1}
        >
          <textarea
            key={resetKey}
            ref={textareaReference}
            placeholder='Ask anything... "Fix broken tests"'
            minHeight={1}
            maxHeight={3}
            onSubmit={handleTextareaSubmit}
            focused
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
              const typedEvent = keyEvent as import("@opentui/core").KeyEvent & {
                preventDefault: () => void;
              };
              if (
                typedEvent.name === "tab" &&
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
            <text fg={agentColor ?? theme.secondary} content={agentName} />
            <text fg={theme.text} content={currentModelDisplayName} />
            <text fg={theme.textMuted} content={currentProviderDisplayName} />
          </box>
          <box height={1} />
        </box>
      </box>
    </box>
  );
};
