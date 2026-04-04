import { useTheme } from "@/tui/_context/theme.tsx";

const LOGO_LINES = [
  "█░░█ █▀▀▄ ▄▀▀▄ █░░█ █▀▀▀ █▀▀▄   █▀▀▀ █▀▀█ █▀▀▄ █▀▀▀",
  "█▀▀░ █▀▀░ █▀▀█ █▀▀░ █▀▀░ █░░█   █░░░ █░░█ █░░█ █▀▀░",
  "█░░█ █░░█ █░░█ █░░█ ████ █  █   ████ ████ ████ ████",
];

export const Logo = () => {
  const { theme } = useTheme();

  return (
    <box flexDirection="column" alignItems="center">
      {LOGO_LINES.map((line, i) => (
        <text key={i} fg={theme.accent} content={line} />
      ))}
    </box>
  );
};
