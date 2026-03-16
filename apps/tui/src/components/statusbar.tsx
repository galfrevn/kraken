import { useState, useEffect } from "react";
import { COLORS } from "@/theme.ts";
import type { LanguageModelClient } from "@core/language/client.ts";

interface StatusBarProperties {
  languageModelClient: LanguageModelClient;
  daemonConnected: boolean;
}

export function StatusBar({ languageModelClient, daemonConnected }: StatusBarProperties) {
  const [currentTokenUsage, setCurrentTokenUsage] = useState({ totalPromptTokens: 0, totalCompletionTokens: 0, requestCount: 0 });

  useEffect(() => {
    const refreshInterval = setInterval(() => {
      setCurrentTokenUsage(languageModelClient.getTokenUsage());
    }, 2000);
    return () => clearInterval(refreshInterval);
  }, [languageModelClient]);

  const totalTokenCount = currentTokenUsage.totalPromptTokens + currentTokenUsage.totalCompletionTokens;
  const estimatedCostInDollars = (totalTokenCount / 1_000_000) * 3;
  const formattedCost = estimatedCostInDollars < 0.01 ? "<$0.01" : `$${estimatedCostInDollars.toFixed(2)}`;
  const daemonStatusLabel = daemonConnected ? "daemon connected" : "local mode";
  const daemonStatusColor = daemonConnected ? COLORS.green : COLORS.yellow;

  return (
    <box flexDirection="row" height={1} width="100%" backgroundColor={COLORS.surface} paddingLeft={1} paddingRight={1}>
      <text fg={COLORS.blue}>{languageModelClient.getModel()}</text>
      <text fg={COLORS.textMuted}>{" │ "}</text>
      <text fg={COLORS.textSecondary}>{`${totalTokenCount.toLocaleString()} tokens`}</text>
      <text fg={COLORS.textMuted}>{" │ "}</text>
      <text fg={COLORS.textSecondary}>{formattedCost}</text>
      <box flexGrow={1} />
      <text fg={daemonStatusColor}>{daemonStatusLabel}</text>
    </box>
  );
}
