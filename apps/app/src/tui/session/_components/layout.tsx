import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/tui/_context/theme.tsx";
import { Sidebar, type SidebarProperties } from "@/tui/session/_components/sidebar.tsx";

interface SessionLayoutProperties {
  children: React.ReactNode;
  sidebarProperties: SidebarProperties;
}

export const SessionLayout = ({ children, sidebarProperties }: SessionLayoutProperties) => {
  const { theme } = useTheme();
  const terminalDimensions = useTerminalDimensions();

  return (
    <box
      flexDirection="row"
      width={terminalDimensions.width}
      height={terminalDimensions.height}
      backgroundColor={theme.background}
    >
      <box flexDirection="column" flexGrow={1} paddingY={0} paddingX={2}>
        {children}
      </box>
      <Sidebar {...sidebarProperties} />
    </box>
  );
};
