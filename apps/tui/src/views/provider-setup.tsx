import { useState, useEffect, useRef, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import { COLORS } from "@/theme.ts";
import { appendToGlobalEnvFile } from "@core/configuration/loader.ts";

export interface ProviderOption {
  name: string;
  label: string;
  description: string;
  envVar: string;
}

interface ProviderSetupPanelProps {
  providers: ProviderOption[];
  onComplete: (configuredProvider?: ProviderOption) => void;
}

type Step = "provider" | "apikey";

const STEPS: { id: Step; label: string }[] = [
  { id: "provider", label: "Provider" },
  { id: "apikey", label: "API Key" },
];

export function ProviderSetupPanel({ providers, onComplete }: ProviderSetupPanelProps) {
  const [step, setStep] = useState<Step>("provider");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<ProviderOption | null>(null);
  const inputRef = useRef<TextareaRenderable>(null);

  useEffect(() => {
    if (step === "apikey") {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [step]);

  const selectProvider = useCallback(() => {
    const provider = providers[selectedIndex];
    if (!provider) return;
    setSelectedProvider(provider);
    setStep("apikey");
  }, [selectedIndex, providers]);

  const submitApiKey = useCallback(async () => {
    const text = inputRef.current?.plainText?.trim() ?? "";
    if (!text || !selectedProvider) return;
    await appendToGlobalEnvFile(selectedProvider.envVar, text);
    onComplete(selectedProvider);
  }, [selectedProvider, onComplete]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      onComplete();
      return;
    }

    if (step === "provider") {
      if (key.name === "up") {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.name === "down") {
        setSelectedIndex((prev) => Math.min(providers.length - 1, prev + 1));
      } else if (key.name === "return") {
        selectProvider();
      }
    } else if (step === "apikey") {
      if (key.name === "return") {
        submitApiKey();
      }
    }
  });

  if (providers.length === 0) {
    onComplete();
    return null;
  }

  const currentStepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <box
      flexDirection="column"
      width="100%"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={COLORS.inputBackground}
    >
      {/* Step bar */}
      <box flexDirection="row" width="100%" paddingBottom={1}>
        {STEPS.map((s, idx) => {
          const isCurrent = s.id === step;
          const isPast = idx < currentStepIndex;
          return (
            <box key={s.id} flexDirection="row">
              {idx > 0 ? <text fg={COLORS.textMuted}>{"  ▸  "}</text> : null}
              <box
                backgroundColor={isCurrent ? COLORS.purple : undefined}
                paddingLeft={1}
                paddingRight={1}
              >
                <text
                  fg={isCurrent ? COLORS.background : isPast ? COLORS.textMuted : COLORS.textMuted}
                >
                  <b>{s.label}</b>
                </text>
              </box>
            </box>
          );
        })}
      </box>

      {step === "provider" ? (
        <box flexDirection="column" width="100%">
          <box width="100%" paddingBottom={1}>
            <text fg={COLORS.text}>
              <b>{"Select a provider to configure"}</b>
            </text>
          </box>

          {providers.map((provider, idx) => {
            const isSelected = idx === selectedIndex;
            const arrow = isSelected ? "→" : " ";
            const bullet = isSelected ? "●" : "○";
            return (
              <box
                key={provider.name}
                flexDirection="column"
                width="100%"
                onMouseUp={() => {
                  setSelectedIndex(idx);
                  selectProvider();
                }}
              >
                <box flexDirection="row" width="100%">
                  <text fg={isSelected ? COLORS.purple : COLORS.textMuted}>
                    {`${arrow} ${bullet} `}
                  </text>
                  <text fg={isSelected ? COLORS.text : COLORS.textSecondary}>
                    <b>{`${idx + 1}. ${provider.label}`}</b>
                  </text>
                </box>
                <box flexDirection="row" width="100%" paddingLeft={5} paddingBottom={0}>
                  <text fg={COLORS.textMuted}>{provider.description}</text>
                </box>
              </box>
            );
          })}

          <box flexDirection="row" width="100%" paddingTop={1} gap={2}>
            <text fg={COLORS.textMuted}>{"↑↓ move"}</text>
            <text fg={COLORS.textMuted}>{"enter select"}</text>
            <text fg={COLORS.textMuted}>{"esc dismiss"}</text>
          </box>
        </box>
      ) : selectedProvider ? (
        <box flexDirection="column" width="100%">
          <box width="100%" paddingBottom={1}>
            <text fg={COLORS.text}>
              <b>{`Enter your ${selectedProvider.label} API key`}</b>
            </text>
          </box>

          <box flexDirection="row" width="100%" paddingBottom={1}>
            <text fg={COLORS.textMuted}>{"env var: "}</text>
            <text>{selectedProvider.envVar}</text>
          </box>

          <box width="100%" height={3} backgroundColor={COLORS.inputBackground} padding={1}>
            <textarea
              ref={inputRef}
              initialValue=""
              placeholder="sk-..."
              textColor={COLORS.text}
              backgroundColor={COLORS.inputBackground}
            />
          </box>

          <box flexDirection="row" width="100%" paddingTop={1} gap={2}>
            <text fg={COLORS.textMuted}>
              <b>{"enter"}</b>
              {" save"}
            </text>
            <text fg={COLORS.textMuted}>
              <b>{"esc"}</b>
              {" cancel"}
            </text>
          </box>
        </box>
      ) : null}
    </box>
  );
}
