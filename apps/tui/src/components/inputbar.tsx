import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS } from "@/theme.ts";
import { ALL_COMMANDS } from "@/commands.ts";

interface InputBarProperties {
  onSubmit: (inputText: string) => void;
  onCancel: () => void;
  isProcessing: boolean;
  focused: boolean;
}

export function InputBar({ onSubmit, onCancel, isProcessing, focused }: InputBarProperties) {
  const [currentInputText, setCurrentInputText] = useState("");
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyNavigationIndex, setHistoryNavigationIndex] = useState(-1);

  useKeyboard((key) => {
    if (!focused) return;

    if (key.ctrl && key.name === "c") {
      if (isProcessing) {
        onCancel();
      } else if (currentInputText) {
        setCurrentInputText("");
      }
      return;
    }

    if (key.name === "return") {
      if (!currentInputText.trim()) return;
      const submittedText = currentInputText;
      setInputHistory((previousHistory) => [submittedText, ...previousHistory].slice(0, 50));
      setHistoryNavigationIndex(-1);
      setCurrentInputText("");
      onSubmit(submittedText);
      return;
    }

    if (key.name === "backspace") {
      setCurrentInputText((previousText) => previousText.slice(0, -1));
      return;
    }

    if (key.name === "up" && currentInputText === "") {
      setHistoryNavigationIndex((previousIndex) => {
        const nextIndex = Math.min(previousIndex + 1, inputHistory.length - 1);
        const historyEntry = inputHistory[nextIndex];
        if (historyEntry !== undefined) setCurrentInputText(historyEntry);
        return nextIndex;
      });
      return;
    }

    if (key.name === "down" && historyNavigationIndex >= 0) {
      setHistoryNavigationIndex((previousIndex) => {
        const nextIndex = previousIndex - 1;
        if (nextIndex < 0) {
          setCurrentInputText("");
          return -1;
        }
        const historyEntry = inputHistory[nextIndex];
        if (historyEntry !== undefined) setCurrentInputText(historyEntry);
        return nextIndex;
      });
      return;
    }

    if (key.sequence && !key.ctrl && !key.meta) {
      setCurrentInputText((previousText) => previousText + key.sequence);
    }
  });

  const isSlashCommandPrefix = currentInputText.startsWith("/");
  const matchingCommands = isSlashCommandPrefix
    ? ALL_COMMANDS.filter((command) =>
        ("/" + command.name).startsWith(currentInputText.toLowerCase()) ||
        command.aliases.some((alias) => ("/" + alias).startsWith(currentInputText.toLowerCase()))
      ).slice(0, 3)
    : [];

  const promptSymbol = isProcessing ? "..." : ">";
  const promptColor = focused ? COLORS.blue : COLORS.textMuted;

  return (
    <box flexDirection="column">
      {matchingCommands.length > 0 && currentInputText.length > 1 && (
        <box flexDirection="row" paddingLeft={2} height={1}>
          <text fg={COLORS.textMuted}>
            {matchingCommands.map((command) => `/${command.name}`).join("  ")}
          </text>
        </box>
      )}
      <box flexDirection="row" height={1} backgroundColor={COLORS.inputBackground} paddingLeft={1}>
        <text fg={promptColor}>{promptSymbol + " "}</text>
        <text fg={COLORS.text}>{currentInputText}</text>
        {focused && <text fg={COLORS.blue}>{"█"}</text>}
      </box>
    </box>
  );
}
