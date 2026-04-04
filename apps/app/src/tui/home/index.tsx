import { useEffect, useState, useCallback } from "react";
import { useTerminalDimensions, useKeyboard, useRenderer } from "@opentui/react";
import { useDialog } from "@opentui-ui/dialog/react";
import { useRoute } from "@/tui/_context/route.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useModels } from "@/tui/_context/models.tsx";
import { useCommands } from "@/tui/_context/commands.tsx";
import { ModelPickerContent } from "@/tui/session/_components/model.tsx";
import { ThemePickerContent } from "@/tui/session/_components/theme.tsx";
import type { ModelSelection } from "@/models/types.ts";
import { getPrimaryAgents, type AgentColor } from "@/agent/agent.ts";
import type { ThemeColors } from "@/tui/_context/theme.tsx";
function resolveAgentColor(colorKey: AgentColor | undefined, themeColors: ThemeColors): string {
  if (!colorKey) return themeColors.secondary;
  return themeColors[colorKey] ?? themeColors.secondary;
}

import { Logo } from "@/tui/home/_components/logo.tsx";
import { Prompt } from "@/tui/home/_components/prompt.tsx";
import { Shortcuts } from "@/tui/home/_components/shortcuts.tsx";
import { Tip } from "@/tui/home/_components/tip.tsx";
import { Footer } from "@/tui/home/_components/footer.tsx";

export const Home = () => {
  const { theme } = useTheme();
  const route = useRoute();
  const sdk = useSdk();
  const terminalDimensions = useTerminalDimensions();
  const renderer = useRenderer();
  const dialog = useDialog();
  const { selectModel } = useModels();
  const commands = useCommands();

  const primaryAgents = getPrimaryAgents();
  const [currentAgentIndex, setCurrentAgentIndex] = useState(0);
  const currentAgent = primaryAgents[currentAgentIndex] ?? primaryAgents[0]!;

  const currentAgentColor = resolveAgentColor(currentAgent.color, theme);

  const handleToggleAgent = useCallback(() => {
    setCurrentAgentIndex((prev) => (prev + 1) % primaryAgents.length);
  }, [primaryAgents.length]);

  useEffect(() => {
    const unregisterCommands = commands.register(() => [
      {
        title: "Resume session",
        value: "session.list",
        description: "Resume a previous conversation",
        slash: { name: "sessions", aliases: ["resume", "continue"] },
        onSelect: () => {
          (async () => {
            const { SessionPickerContent } =
              await import("@/tui/session/_components/session-picker.tsx");
            const selectedSession = await dialog.choice<{ id: string }>({
              content: (choiceContext) => (
                <SessionPickerContent {...choiceContext} sdk={sdk} theme={theme} />
              ),
              size: "large",
            });
            if (selectedSession) {
              route.goToSession(selectedSession.id);
            }
          })().catch(() => {});
        },
      },
      {
        title: "Select model",
        value: "model.select",
        description: "Open the model picker",
        slash: { name: "model" },
        onSelect: () => {
          (async () => {
            const selectedModelResult = await dialog.choice<ModelSelection>({
              content: (choiceContext) => <ModelPickerContent {...choiceContext} />,
              size: "medium",
            });
            if (selectedModelResult) {
              await selectModel(selectedModelResult.modelId, selectedModelResult.providerId);
            }
          })().catch(() => {});
        },
      },
      {
        title: "Switch theme",
        value: "theme.switch",
        description: "Change the color theme",
        slash: { name: "theme", aliases: ["themes"] },
        onSelect: () => {
          (async () => {
            await dialog.choice<string>({
              content: (choiceContext) => <ThemePickerContent {...choiceContext} />,
              size: "large",
            });
          })().catch(() => {});
        },
      },
      {
        title: "Task dashboard",
        value: "tasks.dashboard",
        description: "View background tasks and their status",
        slash: { name: "tasks", aliases: ["dashboard"] },
        onSelect: () => route.goToTasks(),
      },
      {
        title: "Inbox",
        value: "inbox.open",
        description: "View incoming daemon events and notifications",
        slash: { name: "inbox", aliases: ["notifications"] },
        onSelect: () => route.goToInbox(),
      },
      {
        title: "Exit Kraken",
        value: "app.exit",
        description: "Exit the application",
        slash: { name: "exit", aliases: ["quit"] },
        onSelect: () => {
          renderer.destroy();
          process.exit(0);
        },
      },
    ]);
    return unregisterCommands;
  }, []);

  useKeyboard((keyEvent) => {
    if (keyEvent.ctrl && keyEvent.name === "m") {
      (async () => {
        const selectedModelResult = await dialog.choice<ModelSelection>({
          content: (choiceContext) => <ModelPickerContent {...choiceContext} />,
          size: "medium",
        });
        if (selectedModelResult) {
          await selectModel(selectedModelResult.modelId, selectedModelResult.providerId);
        }
      })().catch(() => {});
    }
    if (keyEvent.ctrl && keyEvent.name === "t") {
      route.goToTasks();
    }
    if (keyEvent.ctrl && keyEvent.name === "i") {
      route.goToInbox();
    }
    if (keyEvent.ctrl && keyEvent.name === "c") {
      renderer.destroy();
      process.exit(0);
    }
  });

  async function handlePromptSubmit(userInputText: string) {
    try {
      const createSessionResponse = await sdk.client.post("/session", { agentId: currentAgent.id });
      if (!createSessionResponse.ok) return;
      const createdSession = (await createSessionResponse.json()) as { id: string };
      if (!createdSession.id) return;
      route.goToSession(createdSession.id, userInputText);
    } catch {}
  }

  return (
    <box
      flexDirection="column"
      alignItems="center"
      width={terminalDimensions.width}
      height={terminalDimensions.height}
      backgroundColor={theme.background}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexGrow={1} minHeight={0} />
      <box height={4} minHeight={0} flexShrink={1} />
      <Logo />
      <box height={1} minHeight={0} flexShrink={1} />
      <Prompt
        onSubmit={handlePromptSubmit}
        agentName={currentAgent.name}
        agentColor={currentAgentColor}
        onToggleAgent={handleToggleAgent}
      />
      <box
        height={4}
        minHeight={0}
        width="100%"
        maxWidth={75}
        alignItems="center"
        paddingTop={1}
        flexShrink={1}
      >
        <Shortcuts />
      </box>
      <box
        height={4}
        minHeight={0}
        width="100%"
        maxWidth={75}
        alignItems="center"
        paddingTop={1}
        flexShrink={1}
      >
        <Tip />
      </box>
      <box flexGrow={1} minHeight={0} />
      <Footer />
    </box>
  );
};
