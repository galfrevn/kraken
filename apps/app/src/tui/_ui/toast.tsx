import { useState, useEffect, useCallback } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import { EMPTY_BORDER_CHARACTERS } from "@/tui/_theme/borders.ts";

type ToastVariant = "error" | "warning" | "success" | "info";

interface ToastOptions {
  variant: ToastVariant;
  message: string;
  title?: string;
  duration?: number;
}

const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  error: 5000,
  warning: 4000,
  success: 3000,
  info: 3000,
};

export const { Provider: ToastProvider, use: useToast } = createSimpleContext({
  name: "Toast",
  init: () => {
    const [current, setCurrent] = useState<ToastOptions | null>(null);

    useEffect(() => {
      if (!current) return;
      const duration = current.duration ?? DEFAULT_DURATIONS[current.variant];
      const timer = setTimeout(() => setCurrent(null), duration);
      return () => clearTimeout(timer);
    }, [current]);

    const show = useCallback((options: ToastOptions) => setCurrent(options), []);

    const error = useCallback(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        show({ variant: "error", message, title: "Error" });
      },
      [show],
    );

    return { current, show, error };
  },
});

export const ToastOverlay = () => {
  const { theme } = useTheme();
  const { current } = useToast();
  const { width: termWidth } = useTerminalDimensions();

  if (!current) return null;

  const variantColorMap: Record<ToastVariant, string> = {
    error: theme.error,
    warning: theme.warning,
    success: theme.success,
    info: theme.accent,
  };

  const borderColor = variantColorMap[current.variant];
  const maxWidth = Math.min(60, termWidth - 6);

  return (
    <box
      position="absolute"
      top={1}
      right={2}
      width={maxWidth}
      flexDirection="column"
      border={["left", "right"] as const}
      customBorderChars={{ ...EMPTY_BORDER_CHARACTERS, vertical: "│" }}
      borderColor={borderColor}
      backgroundColor={theme.backgroundPanel}
      paddingX={2}
      paddingY={1}
    >
      {current.title && (
        <text fg={borderColor} content={current.title} attributes={TextAttributes.BOLD} />
      )}
      <text fg={theme.text} content={current.message} />
    </box>
  );
};
