import { useState, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS } from "@/theme.ts";
import type { ChatMessage } from "@/engine.ts";
import { ToolCallDisplay } from "@/components/toolcall.tsx";

interface MessageListProperties {
  chatMessages: ChatMessage[];
  inputFocused: boolean;
}

export function MessageList({ chatMessages, inputFocused }: MessageListProperties) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);
  const previousMessageCount = useRef(chatMessages.length);

  useEffect(() => {
    if (chatMessages.length > previousMessageCount.current && !userHasScrolledUp) {
      setScrollOffset(0);
    }
    previousMessageCount.current = chatMessages.length;
  }, [chatMessages.length, userHasScrolledUp]);

  useKeyboard((key) => {
    if (inputFocused) return;
    if (key.name === "up") {
      setScrollOffset((previousOffset) => previousOffset + 1);
      setUserHasScrolledUp(true);
    }
    if (key.name === "down") {
      setScrollOffset((previousOffset) => {
        const newOffset = Math.max(0, previousOffset - 1);
        if (newOffset === 0) setUserHasScrolledUp(false);
        return newOffset;
      });
    }
  });

  const visibleMessages = scrollOffset > 0
    ? chatMessages.slice(0, chatMessages.length - scrollOffset)
    : chatMessages;

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      {visibleMessages.map((chatMessage, messageIndex) => {
        if (chatMessage.role === "tool_call" || chatMessage.role === "tool_result") {
          if (chatMessage.role === "tool_result") return null;
          const correspondingResult = visibleMessages[messageIndex + 1];
          const toolResultMessage = correspondingResult?.role === "tool_result" ? correspondingResult : undefined;
          return (
            <ToolCallDisplay
              key={messageIndex}
              toolCallMessage={chatMessage}
              toolResultMessage={toolResultMessage}
            />
          );
        }

        return <MessageBubble key={messageIndex} chatMessage={chatMessage} />;
      })}
      {scrollOffset > 0 && (
        <box height={1} width="100%">
          <text fg={COLORS.yellow}>{`↑ ${scrollOffset} message${scrollOffset === 1 ? "" : "s"} above`}</text>
        </box>
      )}
    </box>
  );
}

function MessageBubble({ chatMessage }: { chatMessage: ChatMessage }) {
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (!chatMessage.streaming) return;
    const blinkInterval = setInterval(() => {
      setCursorVisible((previousVisibility) => !previousVisibility);
    }, 500);
    return () => clearInterval(blinkInterval);
  }, [chatMessage.streaming]);

  if (chatMessage.role === "user") {
    return (
      <box flexDirection="column" paddingBottom={1}>
        <text fg={COLORS.blue}>{"▸ you"}</text>
        <text fg={COLORS.text}>{chatMessage.content}</text>
      </box>
    );
  }

  if (chatMessage.role === "assistant") {
    const displayContent = chatMessage.streaming
      ? chatMessage.content + (cursorVisible ? "█" : " ")
      : chatMessage.content;

    return (
      <box flexDirection="column" paddingBottom={1}>
        <text fg={COLORS.purple}>{"▸ kraken"}</text>
        <text fg={COLORS.text}>{displayContent || (chatMessage.streaming ? "thinking..." : "")}</text>
      </box>
    );
  }

  if (chatMessage.role === "error") {
    return (
      <box paddingBottom={1}>
        <text fg={COLORS.red}>{"error: " + chatMessage.content}</text>
      </box>
    );
  }

  if (chatMessage.role === "status") {
    return (
      <box paddingBottom={1}>
        <text fg={COLORS.textMuted}>{chatMessage.content}</text>
      </box>
    );
  }

  return null;
}
