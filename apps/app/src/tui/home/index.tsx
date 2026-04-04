import { useState, useEffect, useCallback } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useDialog } from "@opentui-ui/dialog/react";
import { useRoute } from "@/tui/_context/route.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import { useModels } from "@/tui/_context/models.tsx";
import { useCommands } from "@/tui/_context/commands.tsx";
import { ModelPickerContent } from "@/tui/session/_components/model.tsx";
import { ThemePickerContent } from "@/tui/session/_components/theme.tsx";
import { SessionPickerContent } from "@/tui/session/_components/session-picker.tsx";
import type { ModelSelection } from "@/models/types.ts";
import { getPrimaryAgents, type AgentColor } from "@/agent/agent.ts";
import type { ThemeColors } from "@/tui/_context/theme.tsx";

import { useToast } from "@/tui/_ui/toast.tsx";
import { SessionLayout } from "@/tui/session/_components/layout.tsx";
import { SessionPrompt } from "@/tui/session/_components/prompt.tsx";
import { EmptyState } from "@/tui/session/_components/empty-state.tsx";

function resolveAgentColor(colorKey: AgentColor | undefined, themeColors: ThemeColors): string {
  if (!colorKey) return themeColors.secondary;
  return themeColors[colorKey] ?? themeColors.secondary;
}

export const Home = () => {
  const { theme } = useTheme();
  const route = useRoute();
  const sdk = useSdk();
  const renderer = useRenderer();
  const dialog = useDialog();
  const { selectModel } = useModels();
  const commands = useCommands();

  const primaryAgents = getPrimaryAgents();
  const [currentAgentIndex, setCurrentAgentIndex] = useState(0);
  const currentAgent = primaryAgents[currentAgentIndex] ?? primaryAgents[0]!;
  const currentAgentColor = resolveAgentColor(currentAgent.color, theme);
  const toast = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const openDialog = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setIsDialogOpen(true);
    try {
      return await fn();
    } finally {
      setIsDialogOpen(false);
    }
  }, []);

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
          openDialog(async () => {
            const selectedSession = await dialog.choice<{ id: string }>({
              content: (choiceContext) => (
                <SessionPickerContent {...choiceContext} sdk={sdk} theme={theme} />
              ),
              size: "large",
            });
            if (selectedSession) {
              route.goToSession(selectedSession.id);
            }
          }).catch(() => {});
        },
      },
      {
        title: "Select model",
        value: "model.select",
        description: "Open the model picker",
        slash: { name: "model" },
        onSelect: () => {
          openDialog(async () => {
            const selectedModelResult = await dialog.choice<ModelSelection>({
              content: (choiceContext) => <ModelPickerContent {...choiceContext} />,
              size: "medium",
            });
            if (selectedModelResult) {
              await selectModel(selectedModelResult.modelId, selectedModelResult.providerId);
            }
          }).catch(() => {});
        },
      },
      {
        title: "Switch theme",
        value: "theme.switch",
        description: "Change the color theme",
        slash: { name: "theme", aliases: ["themes"] },
        onSelect: () => {
          openDialog(async () => {
            await dialog.choice<string>({
              content: (choiceContext) => <ThemePickerContent {...choiceContext} />,
              size: "large",
            });
          }).catch(() => {});
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
      openDialog(async () => {
        const selectedModelResult = await dialog.choice<ModelSelection>({
          content: (choiceContext) => <ModelPickerContent {...choiceContext} />,
          size: "medium",
        });
        if (selectedModelResult) {
          await selectModel(selectedModelResult.modelId, selectedModelResult.providerId);
        }
      }).catch(() => {});
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
      if (!createSessionResponse.ok) {
        toast.show({
          variant: "error",
          title: "Failed to create session",
          message: "Server returned an error",
        });
        return;
      }
      const createdSession = (await createSessionResponse.json()) as { id: string };
      if (!createdSession.id) return;
      route.goToSession(createdSession.id, userInputText);
    } catch (err) {
      toast.show({ variant: "error", title: "Connection error", message: String(err) });
    }
  }

  return (
    <SessionLayout
      sidebarProperties={{
        sessionTitle: "New Session",
        tokenCount: 0,
        tokenPercentage: 0,
        estimatedCost: 0,
        agentName: currentAgent.name,
        agentColor: currentAgentColor,
      }}
    >
      <EmptyState />

      <SessionPrompt
        onSubmit={handlePromptSubmit}
        disabled={isDialogOpen}
        isProcessing={false}
        agentName={currentAgent.name}
        agentColor={currentAgentColor}
        onToggleAgent={handleToggleAgent}
      />
    </SessionLayout>
  );
};
