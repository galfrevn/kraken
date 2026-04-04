import { DialogProvider } from "@opentui-ui/dialog/react";
import { ModelsProvider } from "@/tui/_context/models.tsx";
import { RouteProvider } from "@/tui/_context/route.tsx";
import { SdkProvider } from "@/tui/_context/sdk.tsx";
import { ThemeProvider } from "@/tui/_context/theme.tsx";
import { CommandsProvider } from "@/tui/_context/commands.tsx";
import { DaemonStatusProvider } from "@/daemon/status.tsx";
import { ToastProvider, ToastOverlay } from "@/tui/_ui/toast.tsx";
import { Router } from "@/tui/router.tsx";

export const App = () => {
  return (
    <SdkProvider>
      <ThemeProvider>
        <ModelsProvider>
          <DaemonStatusProvider>
            <ToastProvider>
              <DialogProvider>
                <RouteProvider>
                  <CommandsProvider>
                    <Router />
                    <ToastOverlay />
                  </CommandsProvider>
                </RouteProvider>
              </DialogProvider>
            </ToastProvider>
          </DaemonStatusProvider>
        </ModelsProvider>
      </ThemeProvider>
    </SdkProvider>
  );
};
