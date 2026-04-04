import { useState, useMemo, useRef, useCallback } from "react";
import { type ChoiceContext } from "@opentui-ui/dialog/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions, useKeyboard } from "@opentui/react";
import fuzzysort from "fuzzysort";
import { useModels } from "@/tui/_context/models.tsx";
import { useTheme } from "@/tui/_context/theme.tsx";
import type { ModelInfo, ModelSelection } from "@/models/types.ts";

const PAGE_SCROLL_ITEM_COUNT = 10;

type ModelPickerContentProperties = ChoiceContext<ModelSelection>;

interface DisplayModelOption {
  modelInfo: ModelInfo;
  section: "favorite" | "recent" | "provider";
  sectionLabel: string;
}

export const ModelPickerContent = ({ resolve }: ModelPickerContentProperties) => {
  const { theme } = useTheme();
  const terminalDimensions = useTerminalDimensions();
  const { providers, current, favorites, recents, overriddenByEnvironment, toggleFavorite } =
    useModels();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const scrollboxReference = useRef<ScrollBoxRenderable>(null);

  const allModelOptions = useMemo((): DisplayModelOption[] => {
    const optionsList: DisplayModelOption[] = [];
    const addedModelKeys = new Set<string>();

    const allModels: ModelInfo[] = Object.values(providers).flatMap(
      (providerModels) => providerModels.models,
    );

    for (const favoriteSelection of favorites) {
      const matchingModel = allModels.find(
        (model) =>
          model.id === favoriteSelection.modelId &&
          model.providerId === favoriteSelection.providerId,
      );
      if (matchingModel) {
        const modelKey = `${matchingModel.providerId}:${matchingModel.id}`;
        if (!addedModelKeys.has(modelKey)) {
          addedModelKeys.add(modelKey);
          optionsList.push({
            modelInfo: matchingModel,
            section: "favorite",
            sectionLabel: "Favorites",
          });
        }
      }
    }

    for (const recentSelection of recents) {
      const matchingModel = allModels.find(
        (model) =>
          model.id === recentSelection.modelId && model.providerId === recentSelection.providerId,
      );
      if (matchingModel) {
        const modelKey = `${matchingModel.providerId}:${matchingModel.id}`;
        if (!addedModelKeys.has(modelKey)) {
          addedModelKeys.add(modelKey);
          optionsList.push({ modelInfo: matchingModel, section: "recent", sectionLabel: "Recent" });
        }
      }
    }

    for (const [, providerModels] of Object.entries(providers)) {
      for (const modelInfo of providerModels.models) {
        const modelKey = `${modelInfo.providerId}:${modelInfo.id}`;
        if (!addedModelKeys.has(modelKey)) {
          addedModelKeys.add(modelKey);
          optionsList.push({
            modelInfo,
            section: "provider",
            sectionLabel: modelInfo.providerName,
          });
        }
      }
    }

    return optionsList;
  }, [providers, favorites, recents]);

  const filteredModelOptions = useMemo(() => {
    if (!searchQuery.trim()) return allModelOptions;

    const searchResults = fuzzysort.go(searchQuery, allModelOptions, {
      keys: [
        (option: DisplayModelOption) => option.modelInfo.name,
        (option: DisplayModelOption) => option.modelInfo.id,
        (option: DisplayModelOption) => option.modelInfo.providerName,
      ],
    });

    return searchResults.map((result) => result.obj);
  }, [allModelOptions, searchQuery]);

  const computedListMaxHeight = useMemo(() => {
    return Math.min(filteredModelOptions.length, Math.floor(terminalDimensions.height / 2) - 6);
  }, [filteredModelOptions.length, terminalDimensions.height]);

  const moveSelection = useCallback(
    (direction: number) => {
      setSelectedIndex((previousIndex) => {
        const totalOptions = filteredModelOptions.length;
        if (totalOptions === 0) return 0;
        let nextIndex = previousIndex + direction;
        if (nextIndex < 0) nextIndex = totalOptions - 1;
        if (nextIndex >= totalOptions) nextIndex = 0;

        const currentScrollbox = scrollboxReference.current;
        if (currentScrollbox) {
          const targetOption = filteredModelOptions[nextIndex];
          if (targetOption) {
            const childId = `${targetOption.modelInfo.providerId}:${targetOption.modelInfo.id}`;
            currentScrollbox.scrollChildIntoView(childId);
          }
        }

        return nextIndex;
      });
    },
    [filteredModelOptions.length],
  );

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "up" || (keyEvent.ctrl && keyEvent.name === "p")) {
      moveSelection(-1);
    } else if (keyEvent.name === "down" || (keyEvent.ctrl && keyEvent.name === "n")) {
      moveSelection(1);
    } else if (keyEvent.name === "pageup") {
      moveSelection(-PAGE_SCROLL_ITEM_COUNT);
    } else if (keyEvent.name === "pagedown") {
      moveSelection(PAGE_SCROLL_ITEM_COUNT);
    } else if (keyEvent.name === "escape") {
      resolve(undefined as unknown as ModelSelection);
    } else if (keyEvent.name === "return") {
      const selectedOption = filteredModelOptions[selectedIndex];
      if (selectedOption && !overriddenByEnvironment) {
        resolve({
          modelId: selectedOption.modelInfo.id,
          providerId: selectedOption.modelInfo.providerId,
        });
      }
    } else if (keyEvent.ctrl && keyEvent.name === "f") {
      const selectedOption = filteredModelOptions[selectedIndex];
      if (selectedOption) {
        toggleFavorite(selectedOption.modelInfo.id, selectedOption.modelInfo.providerId);
      }
    }
  });

  const isCurrentModel = (modelInfo: ModelInfo) =>
    modelInfo.id === current.modelId && modelInfo.providerId === current.providerId;

  const sectionBoundaries = useMemo(() => {
    const boundaries: { index: number; label: string }[] = [];
    let lastLabel = "";
    for (let optionIndex = 0; optionIndex < filteredModelOptions.length; optionIndex++) {
      const currentLabel = filteredModelOptions[optionIndex]!.sectionLabel;
      if (currentLabel !== lastLabel) {
        boundaries.push({ index: optionIndex, label: currentLabel });
        lastLabel = currentLabel;
      }
    }
    return boundaries;
  }, [filteredModelOptions]);

  const sectionIndexSet = useMemo(() => {
    return new Set(sectionBoundaries.map((boundary) => boundary.index));
  }, [sectionBoundaries]);

  return (
    <box flexDirection="column" width="100%" paddingTop={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text attributes={TextAttributes.BOLD} fg={theme.text} content="Select model" />
          <text fg={theme.textMuted} content="esc" />
        </box>
      </box>
      <box paddingLeft={4} paddingRight={4} paddingTop={1}>
        <input
          focused
          placeholder="Search"
          marginBottom={1}
          onSubmit={() => {}}
          style={{
            backgroundColor: theme.backgroundElement,
            focusedBackgroundColor: theme.backgroundElement,
          }}
          onInput={(newValue: string) => {
            setSearchQuery(newValue);
            setSelectedIndex(0);
            const currentScrollbox = scrollboxReference.current;
            if (currentScrollbox) currentScrollbox.scrollBy(-currentScrollbox.scrollTop);
          }}
        />
      </box>
      <scrollbox
        ref={scrollboxReference}
        paddingLeft={1}
        paddingRight={1}
        maxHeight={computedListMaxHeight}
        scrollbarOptions={{ visible: false }}
      >
        {filteredModelOptions.map((displayOption, optionIndex) => {
          const isSelected = optionIndex === selectedIndex;
          const isCurrent = isCurrentModel(displayOption.modelInfo);
          const showSectionHeader = sectionIndexSet.has(optionIndex);
          const sectionLabel = showSectionHeader
            ? (sectionBoundaries.find((boundary) => boundary.index === optionIndex)?.label ?? "")
            : "";

          return (
            <box
              key={`${displayOption.modelInfo.providerId}:${displayOption.modelInfo.id}`}
              id={`${displayOption.modelInfo.providerId}:${displayOption.modelInfo.id}`}
              flexDirection="column"
            >
              {sectionLabel !== "" && (
                <box paddingTop={optionIndex > 0 ? 1 : 0} paddingLeft={3}>
                  <text attributes={TextAttributes.BOLD} fg={theme.accent} content={sectionLabel} />
                </box>
              )}
              <box
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={3}
                paddingRight={2}
                backgroundColor={isSelected ? theme.accent : undefined}
              >
                <box flexDirection="row" gap={1} flexGrow={1}>
                  {isCurrent && (
                    <text fg={isSelected ? theme.background : theme.accent} content="●" />
                  )}
                  <text
                    attributes={isSelected ? TextAttributes.BOLD : undefined}
                    fg={isSelected ? theme.background : theme.text}
                    content={displayOption.modelInfo.name}
                  />
                </box>
                <text
                  fg={isSelected ? theme.background : theme.textMuted}
                  content={displayOption.modelInfo.providerName}
                  flexShrink={0}
                />
              </box>
            </box>
          );
        })}
      </scrollbox>
      <box
        paddingRight={2}
        paddingLeft={4}
        flexDirection="row"
        gap={2}
        flexShrink={0}
        paddingTop={1}
      >
        <text attributes={TextAttributes.BOLD} fg={theme.text} content="Favorite" />
        <text fg={theme.textMuted} content="ctrl+f" />
      </box>
    </box>
  );
};
