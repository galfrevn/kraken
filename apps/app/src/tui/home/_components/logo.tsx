import { useTheme } from "@/tui/_context/theme.tsx";

export const Logo = () => {
  const { theme } = useTheme();

  return (
    <box alignItems="center">
      <ascii-font text="kraken" style={{ font: "tiny" }} color={theme.primary} />
    </box>
  );
};
