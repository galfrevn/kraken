import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "@/tui/_context/theme.tsx";

interface QuestionOption {
  label: string;
  description: string;
}

interface QuestionItem {
  id: string;
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

interface QuestionPromptProperties {
  questions: QuestionItem[];
  agentColor?: string;
  onSubmit: (answers: Record<string, string[]>) => void;
  onDismiss: () => void;
}

const CUSTOM_OPTION_VALUE = "__custom__";

export const QuestionPrompt = ({
  questions,
  agentColor,
  onSubmit,
  onDismiss,
}: QuestionPromptProperties) => {
  const { theme } = useTheme();
  const color = agentColor ?? theme.secondary;

  const hasMultipleQuestions = questions.length > 1;
  const totalTabs = hasMultipleQuestions ? questions.length + 1 : questions.length;

  const [activeTab, setActiveTab] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [editingCustom, setEditingCustom] = useState(false);
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const q of questions) {
      initial[q.id] = "";
    }
    return initial;
  });
  const [selections, setSelections] = useState<Record<string, Set<string>>>(() => {
    const initial: Record<string, Set<string>> = {};
    for (const q of questions) {
      initial[q.id] = new Set();
    }
    return initial;
  });

  const isConfirmTab = hasMultipleQuestions && activeTab === questions.length;
  const currentQuestion = isConfirmTab ? null : questions[activeTab]!;
  const optionsWithCustom = currentQuestion
    ? currentQuestion.custom !== false
      ? [...currentQuestion.options, { label: "Type your own answer", description: "" }]
      : currentQuestion.options
    : [];
  const currentSelections = currentQuestion ? selections[currentQuestion.id]! : new Set<string>();
  const isSingleImmediateSubmit =
    questions.length === 1 && !questions[0]!.multiple && questions[0]!.custom === false;

  useEffect(() => {
    setCursor(0);
    setEditingCustom(false);
  }, [activeTab]);

  function buildAnswers(): Record<string, string[]> {
    const answers: Record<string, string[]> = {};
    for (const q of questions) {
      const selected = selections[q.id]!;
      const customText = customTexts[q.id] ?? "";
      const values: string[] = [];

      for (const val of selected) {
        if (val === CUSTOM_OPTION_VALUE) {
          if (customText.trim()) values.push(customText.trim());
        } else {
          values.push(val);
        }
      }

      if (values.length === 0 && q.options.length > 0) {
        values.push(q.options[0]!.label);
      }
      answers[q.id] = values;
    }
    return answers;
  }

  function selectOption(optionIndex: number) {
    if (!currentQuestion) return;
    const isCustomSlot =
      optionIndex === currentQuestion.options.length && currentQuestion.custom !== false;
    const optionValue = isCustomSlot
      ? CUSTOM_OPTION_VALUE
      : currentQuestion.options[optionIndex]?.label;
    if (!optionValue) return;

    setSelections((prev) => {
      const updated = { ...prev };
      const set = new Set(updated[currentQuestion.id]);

      if (currentQuestion.multiple) {
        if (set.has(optionValue)) {
          set.delete(optionValue);
        } else {
          set.add(optionValue);
        }
      } else {
        set.clear();
        set.add(optionValue);
      }

      updated[currentQuestion.id] = set;
      return updated;
    });

    if (isCustomSlot) {
      setEditingCustom(true);
      return;
    }

    if (isSingleImmediateSubmit) {
      const answers: Record<string, string[]> = {};
      answers[currentQuestion.id] = [optionValue];
      onSubmit(answers);
    }
  }

  useKeyboard((keyEvent) => {
    if (editingCustom) {
      if (keyEvent.name === "escape") {
        setEditingCustom(false);
        return;
      }
      if (keyEvent.name === "return") {
        setEditingCustom(false);
        if (isSingleImmediateSubmit) {
          const customText = customTexts[currentQuestion!.id] ?? "";
          if (customText.trim()) {
            const answers: Record<string, string[]> = {};
            answers[currentQuestion!.id] = [customText.trim()];
            onSubmit(answers);
          }
        }
        return;
      }
      if (keyEvent.name === "backspace") {
        setCustomTexts((prev) => {
          const id = currentQuestion!.id;
          const current = prev[id] ?? "";
          return { ...prev, [id]: current.slice(0, -1) };
        });
        return;
      }
      if (keyEvent.sequence && keyEvent.sequence.length === 1 && !keyEvent.ctrl && !keyEvent.meta) {
        setCustomTexts((prev) => {
          const id = currentQuestion!.id;
          const current = prev[id] ?? "";
          return { ...prev, [id]: current + keyEvent.sequence };
        });
        return;
      }
      return;
    }

    if (keyEvent.name === "escape") {
      onDismiss();
      return;
    }

    if (keyEvent.name === "return") {
      if (isConfirmTab || !hasMultipleQuestions) {
        onSubmit(buildAnswers());
      } else {
        selectOption(cursor);
      }
      return;
    }

    if (keyEvent.name === "tab") {
      if (hasMultipleQuestions) {
        setActiveTab((prev) => (prev + 1) % totalTabs);
      }
      return;
    }

    if (keyEvent.name === "up" || keyEvent.name === "k") {
      if (!isConfirmTab) setCursor((prev) => Math.max(0, prev - 1));
      return;
    }

    if (keyEvent.name === "down" || keyEvent.name === "j") {
      if (!isConfirmTab) setCursor((prev) => Math.min(optionsWithCustom.length - 1, prev + 1));
      return;
    }

    if (keyEvent.name === "left" || keyEvent.name === "h") {
      if (hasMultipleQuestions) {
        setActiveTab((prev) => (prev - 1 + totalTabs) % totalTabs);
      }
      return;
    }

    if (keyEvent.name === "right" || keyEvent.name === "l") {
      if (hasMultipleQuestions) {
        setActiveTab((prev) => (prev + 1) % totalTabs);
      }
      return;
    }

    if (keyEvent.name === "space") {
      if (!isConfirmTab) selectOption(cursor);
      return;
    }

    const numKey = parseInt(keyEvent.sequence ?? "", 10);
    if (numKey >= 1 && numKey <= 9 && !isConfirmTab) {
      const idx = numKey - 1;
      if (idx < optionsWithCustom.length) {
        setCursor(idx);
        selectOption(idx);
      }
    }
  });

  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      {hasMultipleQuestions && (
        <box flexDirection="row" gap={2} marginBottom={1} paddingLeft={3}>
          {questions.map((q, index) => (
            <text
              key={q.id}
              fg={index === activeTab ? color : theme.textMuted}
              content={`${index + 1}. ${q.header}`}
            />
          ))}
          <text fg={activeTab === questions.length ? color : theme.textMuted} content="✓ Confirm" />
        </box>
      )}

      <box
        flexDirection="column"
        border={["left"]}
        borderColor={color}
        paddingLeft={2}
        paddingRight={2}
        paddingY={1}
      >
        {isConfirmTab ? (
          <box flexDirection="column">
            <text fg={theme.text} content="Review your answers:" />
            <box height={1} />
            {questions.map((q) => {
              const selected = selections[q.id]!;
              const customText = customTexts[q.id] ?? "";
              const values = Array.from(selected).map((v) =>
                v === CUSTOM_OPTION_VALUE && customText.trim() ? customText.trim() : v,
              );
              const display =
                values.length > 0 ? values.join(", ") : (q.options[0]?.label ?? "(none)");
              return (
                <box key={q.id} flexDirection="column" marginBottom={1}>
                  <text fg={theme.textMuted} content={q.header} />
                  <text fg={color} content={`  ${display}`} />
                </box>
              );
            })}
          </box>
        ) : (
          <>
            <text fg={theme.text} content={currentQuestion!.question} />
            <box height={1} />
            {optionsWithCustom.map((option, index) => {
              const isCustomSlot =
                index === currentQuestion!.options.length && currentQuestion!.custom !== false;
              const optionValue = isCustomSlot ? CUSTOM_OPTION_VALUE : option.label;
              const isSelected = currentSelections.has(optionValue);
              const isCursorHere = index === cursor;

              const icon = currentQuestion!.multiple
                ? isSelected
                  ? "[✓]"
                  : "[ ]"
                : isSelected
                  ? "◉"
                  : "○";

              const iconColor = isSelected ? color : theme.textMuted;
              const labelColor = isCursorHere ? theme.text : theme.textMuted;
              const prefix = isCursorHere ? "▸ " : "  ";
              const numberHint = index < 9 ? `${index + 1}. ` : "   ";

              return (
                <box key={`${optionValue}-${index}`} flexDirection="column">
                  <box flexDirection="row" gap={1}>
                    <text fg={iconColor} content={icon} />
                    <text fg={labelColor} content={`${prefix}${numberHint}${option.label}`} />
                  </box>
                  {option.description && !isCustomSlot && (
                    <text fg={theme.textMuted} content={`        ${option.description}`} />
                  )}
                  {isCustomSlot && editingCustom && isCursorHere && (
                    <box flexDirection="row" marginLeft={4} marginTop={0}>
                      <text fg={theme.textMuted} content="  > " />
                      <text fg={theme.text} content={customTexts[currentQuestion!.id] ?? ""} />
                      <text fg={color} content="▎" />
                    </box>
                  )}
                </box>
              );
            })}
          </>
        )}
      </box>

      <box flexDirection="row" gap={2} paddingLeft={3} marginTop={1}>
        {!editingCustom ? (
          <>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="↑↓" />
              <text fg={theme.textMuted} content="navigate" />
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="1-9" />
              <text fg={theme.textMuted} content="select" />
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="enter" />
              <text
                fg={theme.textMuted}
                content={isConfirmTab || !hasMultipleQuestions ? "confirm" : "select"}
              />
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="esc" />
              <text fg={theme.textMuted} content="dismiss" />
            </box>
            {hasMultipleQuestions && (
              <box flexDirection="row" gap={1}>
                <text fg={theme.text} content="tab" />
                <text fg={theme.textMuted} content="next" />
              </box>
            )}
          </>
        ) : (
          <>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="enter" />
              <text fg={theme.textMuted} content="done" />
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} content="esc" />
              <text fg={theme.textMuted} content="cancel" />
            </box>
          </>
        )}
      </box>
    </box>
  );
};
