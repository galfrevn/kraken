import { useState, useMemo, useRef, useCallback } from "react";
import { type ChoiceContext } from "@opentui-ui/dialog/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { useModels } from "@/tui/_context/models.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import type { ModelInfo, ModelSelection } from "@/models/types.ts";

type ModelPickerContentProperties = ChoiceContext<ModelSelection>;

type PickerStage = "provider" | "model";

interface ProviderOption {
  id: string;
  name: string;
  modelCount: number;
  hasCurrentModel: boolean;
}

export const ModelPickerContent = ({ resolve }: ModelPickerContentProperties) => {
  const { theme } = useTheme();
  const terminalDimensions = useTerminalDimensions();
  const { providers, current, favorites, recents, overriddenByEnvironment, toggleFavorite } =
    useModels();

  const [stage, setStage] = useState<PickerStage>("provider");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const scrollboxReference = useRef<ScrollBoxRenderable>(null);

  const providerOptions = useMemo((): ProviderOption[] => {
    return Object.entries(providers).map(([id, data]) => ({
      id,
      name: data.name,
      modelCount: data.models.length,
      hasCurrentModel: data.models.some(
        (m) => m.id === current.modelId && m.providerId === current.providerId,
      ),
    }));
  }, [providers, current]);

  const modelOptions = useMemo((): ModelInfo[] => {
    if (!selectedProviderId) return [];
    const providerData = providers[selectedProviderId];
    if (!providerData) return [];

    const models = [...providerData.models];

    if (!searchQuery.trim()) {
      const favoriteIds = new Set(
        favorites.filter((f) => f.providerId === selectedProviderId).map((f) => f.modelId),
      );
      const recentIds = new Set(
        recents.filter((r) => r.providerId === selectedProviderId).map((r) => r.modelId),
      );

      models.sort((a, b) => {
        const aFav = favoriteIds.has(a.id) ? 0 : 1;
        const bFav = favoriteIds.has(b.id) ? 0 : 1;
        if (aFav !== bFav) return aFav - bFav;
        const aRecent = recentIds.has(a.id) ? 0 : 1;
        const bRecent = recentIds.has(b.id) ? 0 : 1;
        if (aRecent !== bRecent) return aRecent - bRecent;
        return a.name.localeCompare(b.name);
      });

      return models;
    }

    const results = fuzzysort.go(searchQuery, models, {
      keys: [(m: ModelInfo) => m.name, (m: ModelInfo) => m.id],
    });
    return results.map((r) => r.obj);
  }, [selectedProviderId, providers, searchQuery, favorites, recents]);

  const listMaxHeight = useMemo(() => {
    const items = stage === "provider" ? providerOptions.length : modelOptions.length;
    return Math.min(items, Math.floor(terminalDimensions.height / 2) - 6);
  }, [stage, providerOptions.length, modelOptions.length, terminalDimensions.height]);

  const moveSelection = useCallback(
    (direction: number) => {
      const total = stage === "provider" ? providerOptions.length : modelOptions.length;
      if (total === 0) return;
      setSelectedIndex((prev) => {
        let next = prev + direction;
        if (next < 0) next = total - 1;
        if (next >= total) next = 0;
        return next;
      });
    },
    [stage, providerOptions.length, modelOptions.length],
  );

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "up") moveSelection(-1);
    else if (keyEvent.name === "down") moveSelection(1);
    else if (keyEvent.name === "escape") {
      resolve(undefined as unknown as ModelSelection);
    } else if (keyEvent.name === "left" && stage === "model" && !searchQuery) {
      setStage("provider");
      setSelectedProviderId(null);
      setSearchQuery("");
      setSelectedIndex(0);
    } else if (keyEvent.name === "return") {
      if (stage === "provider") {
        const provider = providerOptions[selectedIndex];
        if (provider) {
          setSelectedProviderId(provider.id);
          setStage("model");
          setSearchQuery("");
          setSelectedIndex(0);
        }
      } else {
        const model = modelOptions[selectedIndex];
        if (model && !overriddenByEnvironment) {
          resolve({ modelId: model.id, providerId: model.providerId });
        }
      }
    } else if (keyEvent.ctrl && keyEvent.name === "f" && stage === "model") {
      const model = modelOptions[selectedIndex];
      if (model) toggleFavorite(model.id, model.providerId);
    }
  });

  const isFavorite = (model: ModelInfo) =>
    favorites.some((f) => f.modelId === model.id && f.providerId === model.providerId);

  const isCurrent = (model: ModelInfo) =>
    model.id === current.modelId && model.providerId === current.providerId;

  if (stage === "provider") {
    return (
      <box flexDirection="column" width="100%" paddingY={1}>
        <box paddingX={4}>
          <box flexDirection="row" justifyContent="space-between" width="100%">
            <text attributes={TextAttributes.BOLD} fg={theme.text} content="Select provider" />
            <text fg={theme.textMuted} content="esc" />
          </box>
        </box>
        <box height={1} />
        <scrollbox
          ref={scrollboxReference}
          paddingX={1}
          maxHeight={listMaxHeight}
          scrollbarOptions={{ visible: false }}
        >
          {providerOptions.map((provider, i) => {
            const isSelected = i === selectedIndex;
            return (
              <box
                key={provider.id}
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={3}
                paddingRight={2}
                backgroundColor={isSelected ? theme.accent : undefined}
              >
                <box flexDirection="row" gap={1}>
                  {provider.hasCurrentModel && (
                    <text fg={isSelected ? theme.background : theme.accent} content="●" />
                  )}
                  <text
                    attributes={isSelected ? TextAttributes.BOLD : undefined}
                    fg={isSelected ? theme.background : theme.text}
                    content={provider.name}
                  />
                </box>
                <text
                  fg={isSelected ? theme.background : theme.textMuted}
                  content={`${provider.modelCount} models`}
                />
              </box>
            );
          })}
        </scrollbox>
        <box paddingX={4} paddingTop={1} flexDirection="row" gap={2}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} content="enter" />
            <text fg={theme.textMuted} content="select" />
          </box>
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" width="100%" paddingY={1}>
      <box paddingX={4}>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <box flexDirection="row" gap={1}>
            <text
              fg={theme.textMuted}
              content={providerOptions.find((p) => p.id === selectedProviderId)?.name ?? ""}
            />
            <text fg={theme.textMuted} content="/" />
            <text attributes={TextAttributes.BOLD} fg={theme.text} content="Select model" />
          </box>
          <text fg={theme.textMuted} content="← back  esc close" />
        </box>
      </box>
      <box paddingX={4} paddingTop={1}>
        <input
          focused
          placeholder="Search models..."
          marginBottom={1}
          onSubmit={() => {}}
          style={{
            backgroundColor: theme.backgroundElement,
            focusedBackgroundColor: theme.backgroundElement,
          }}
          onInput={(newValue: string) => {
            setSearchQuery(newValue);
            setSelectedIndex(0);
          }}
        />
      </box>
      <scrollbox
        ref={scrollboxReference}
        paddingX={1}
        maxHeight={listMaxHeight}
        scrollbarOptions={{ visible: false }}
      >
        {modelOptions.map((model, i) => {
          const isSelected = i === selectedIndex;
          const fav = isFavorite(model);
          const cur = isCurrent(model);
          return (
            <box
              key={model.id}
              flexDirection="row"
              justifyContent="space-between"
              paddingLeft={3}
              paddingRight={2}
              backgroundColor={isSelected ? theme.accent : undefined}
            >
              <box flexDirection="row" gap={1} flexGrow={1}>
                {cur && <text fg={isSelected ? theme.background : theme.accent} content="●" />}
                {fav && !cur && (
                  <text fg={isSelected ? theme.background : theme.warning} content="★" />
                )}
                <text
                  attributes={isSelected ? TextAttributes.BOLD : undefined}
                  fg={isSelected ? theme.background : theme.text}
                  content={model.name}
                  wrapMode="none"
                />
              </box>
            </box>
          );
        })}
        {modelOptions.length === 0 && (
          <box paddingLeft={3}>
            <text fg={theme.textMuted} content="No models found" />
          </box>
        )}
      </scrollbox>
      <box paddingX={4} paddingTop={1} flexDirection="row" gap={2}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} content="ctrl+f" />
          <text fg={theme.textMuted} content="favorite" />
        </box>
      </box>
    </box>
  );
};
