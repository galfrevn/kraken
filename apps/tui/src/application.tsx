import { useState, useCallback, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { COLORS } from "@/theme.ts";
import type { ThreadManager } from "@/threads.ts";
import type { ChatMessage } from "@/engine.ts";
import type { LanguageModelClient } from "@core/language/client.ts";
import { StatusBar } from "@/components/statusbar.tsx";
import { MessageList } from "@/components/messagelist.tsx";
import { InputBar } from "@/components/inputbar.tsx";
import { handleSlashCommand } from "@/commands.ts";

interface ApplicationProperties {
  threadManager: ThreadManager;
  languageModelClient: LanguageModelClient;
  daemonConnected: boolean;
}

export function Application({ threadManager, languageModelClient, daemonConnected }: ApplicationProperties) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isEngineProcessing, setIsEngineProcessing] = useState(false);
  const [inputFocused] = useState(true);
  const { width, height } = useTerminalDimensions();

  useEffect(() => {
    const updateMessagesFromEngine = () => {
      const activeEngine = threadManager.getActiveEngine();
      setChatMessages([...activeEngine.getMessages()]);
      setIsEngineProcessing(activeEngine.isProcessing());
    };

    const activeEngine = threadManager.getActiveEngine();
    activeEngine.addEventListener(updateMessagesFromEngine);
    updateMessagesFromEngine();

    const handleThreadChange = () => {
      const currentEngine = threadManager.getActiveEngine();
      currentEngine.addEventListener(updateMessagesFromEngine);
      updateMessagesFromEngine();
    };

    threadManager.onThreadChange(handleThreadChange);

    return () => {
      activeEngine.removeEventListener(updateMessagesFromEngine);
      threadManager.offThreadChange(handleThreadChange);
    };
  }, [threadManager]);

  const handleUserInputSubmit = useCallback(async (inputText: string) => {
    if (inputText.startsWith("/")) {
      const commandResult = await handleSlashCommand(inputText, threadManager);
      if (commandResult) {
        if (commandResult.switchedThread) {
          const currentEngine = threadManager.getActiveEngine();
          setChatMessages([...currentEngine.getMessages()]);
        }
        return;
      }
    }

    const activeEngine = threadManager.getActiveEngine();
    activeEngine.sendMessage(inputText);
    threadManager.generateActiveThreadTitle();
  }, [threadManager]);

  const handleCancelCurrentResponse = useCallback(() => {
    const activeEngine = threadManager.getActiveEngine();
    activeEngine.cancelCurrentResponse();
  }, [threadManager]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "q") {
      process.exit(0);
    }
  });

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={COLORS.background}>
      <StatusBar languageModelClient={languageModelClient} daemonConnected={daemonConnected} />
      <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <MessageList chatMessages={chatMessages} inputFocused={inputFocused} />
      </box>
      <InputBar
        onSubmit={handleUserInputSubmit}
        onCancel={handleCancelCurrentResponse}
        isProcessing={isEngineProcessing}
        focused={inputFocused}
      />
    </box>
  );
}
