import { useState, useEffect, useRef, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import { COLORS } from "@/theme.ts";
import type { MissingConfigField } from "@core/plugins/registry.ts";
import { appendToGlobalEnvFile } from "@core/configuration/loader.ts";

export interface SetupField {
  pluginName: string;
  fieldName: string;
  field: MissingConfigField["field"];
}

interface SetupPanelProps {
  fields: SetupField[];
  onComplete: () => void;
}

export function SetupPanel({ fields, onComplete }: SetupPanelProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const inputRef = useRef<TextareaRenderable>(null);

  const currentField = fields[currentIndex];
  const isLast = currentIndex === fields.length - 1;

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [currentIndex]);

  const submitCurrent = useCallback(async () => {
    const text = inputRef.current?.plainText?.trim() ?? "";
    if (text && currentField?.field.envVar) {
      await appendToGlobalEnvFile(currentField.field.envVar, text);
    }

    if (isLast) {
      onComplete();
    } else {
      setCurrentIndex((prev) => prev + 1);
    }
  }, [currentIndex, currentField, isLast, onComplete]);

  const skipCurrent = useCallback(() => {
    if (isLast) {
      onComplete();
    } else {
      setCurrentIndex((prev) => prev + 1);
    }
  }, [isLast, onComplete]);

  const skipAll = useCallback(() => {
    onComplete();
  }, [onComplete]);

  useKeyboard((key) => {
    if (key.name === "return") {
      submitCurrent();
    } else if (key.name === "tab" && !key.shift) {
      skipCurrent();
    } else if (key.name === "escape") {
      skipAll();
    }
  });

  if (!currentField) {
    onComplete();
    return null;
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={COLORS.background}
      padding={2}
    >
      <box flexDirection="row" width="100%" paddingBottom={1}>
        <text fg={COLORS.blue}>
          <b>{"Plugin Setup"}</b>
        </text>
        <text fg={COLORS.textMuted}>{`  (${currentIndex + 1}/${fields.length})`}</text>
      </box>

      <box flexDirection="column" width="100%" paddingBottom={1}>
        <box flexDirection="row" width="100%">
          <text fg={COLORS.textMuted}>{"plugin: "}</text>
          <text fg={COLORS.purple}>
            <b>{currentField.pluginName}</b>
          </text>
        </box>
        <box flexDirection="row" width="100%">
          <text fg={COLORS.textMuted}>{"field: "}</text>
          <text fg={COLORS.text}>{currentField.field.description}</text>
        </box>
        {currentField.field.envVar ? (
          <box flexDirection="row" width="100%">
            <text fg={COLORS.textMuted}>{"env var: "}</text>
            <text fg={COLORS.yellow}>{currentField.field.envVar}</text>
          </box>
        ) : null}
      </box>

      <box width="100%" height={3} backgroundColor={COLORS.inputBackground} padding={1}>
        <textarea
          ref={inputRef}
          initialValue=""
          placeholder="enter value..."
          textColor={COLORS.text}
          backgroundColor={COLORS.inputBackground}
        />
      </box>

      <box flexDirection="row" width="100%" paddingTop={1} gap={2}>
        <text fg={COLORS.green}>
          <b>{"enter"}</b>
          {" save"}
        </text>
        <text fg={COLORS.textMuted}>
          <b>{"tab"}</b>
          {" skip"}
        </text>
        <text fg={COLORS.textMuted}>
          <b>{"esc"}</b>
          {" skip all"}
        </text>
      </box>
    </box>
  );
}
