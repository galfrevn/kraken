import { useState, useEffect } from "react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";
import { resolveTheme } from "@/tui/_theme/resolver.ts";
import type { ThemeColors, ThemeJson } from "@/tui/_theme/types.ts";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_THEME_NAME = "kraken";

function loadBuiltinThemes(): Record<string, ThemeJson> {
  const themes: Record<string, ThemeJson> = {};
  const themeDirectory = join(import.meta.dir, "..", "_theme");

  try {
    const themeFiles = readdirSync(themeDirectory).filter((fileName) => fileName.endsWith(".json"));
    for (const themeFile of themeFiles) {
      const themeName = themeFile.replace(".json", "");
      try {
        const themeContent = readFileSync(join(themeDirectory, themeFile), "utf-8");
        themes[themeName] = JSON.parse(themeContent) as ThemeJson;
      } catch {}
    }
  } catch {}

  return themes;
}

const BUILTIN_THEMES = loadBuiltinThemes();

function getThemeStatePath(): string {
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(homeDirectory, ".kraken", "cache", "themestate.json");
}

function loadPersistedThemeName(): string {
  try {
    const stateFilePath = getThemeStatePath();
    if (!existsSync(stateFilePath)) return DEFAULT_THEME_NAME;
    const data = JSON.parse(readFileSync(stateFilePath, "utf-8")) as { theme?: string };
    return data.theme ?? DEFAULT_THEME_NAME;
  } catch {
    return DEFAULT_THEME_NAME;
  }
}

function persistThemeName(themeName: string): void {
  try {
    const stateFilePath = getThemeStatePath();
    const cacheDirectory = join(stateFilePath, "..");
    mkdirSync(cacheDirectory, { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify({ theme: themeName }), "utf-8");
  } catch {}
}

function loadCustomThemes(): Record<string, ThemeJson> {
  const customThemes: Record<string, ThemeJson> = {};
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const customThemesDirectory = join(homeDirectory, ".kraken", "themes");

  if (!existsSync(customThemesDirectory)) return customThemes;

  try {
    const themeFileNames = readdirSync(customThemesDirectory).filter((fileName) =>
      fileName.endsWith(".json"),
    );
    for (const themeFileName of themeFileNames) {
      const themeName = themeFileName.replace(".json", "");
      const themeFilePath = join(customThemesDirectory, themeFileName);
      try {
        const themeFileContent = readFileSync(themeFilePath, "utf-8");
        customThemes[themeName] = JSON.parse(themeFileContent) as ThemeJson;
      } catch {}
    }
  } catch {}

  return customThemes;
}

export const { Provider: ThemeProvider, use: useTheme } = createSimpleContext({
  name: "Theme",
  init: () => {
    const persistedName = loadPersistedThemeName();
    const [currentThemeName, setCurrentThemeName] = useState(
      BUILTIN_THEMES[persistedName] ? persistedName : DEFAULT_THEME_NAME,
    );
    const [themeMode] = useState<"dark" | "light">("dark");
    const [allThemes, setAllThemes] = useState<Record<string, ThemeJson>>(BUILTIN_THEMES);

    useEffect(() => {
      const customThemes = loadCustomThemes();
      if (Object.keys(customThemes).length > 0) {
        setAllThemes((previousThemes) => ({ ...previousThemes, ...customThemes }));
      }
    }, []);

    const selectedThemeJson = (allThemes[currentThemeName] ??
      BUILTIN_THEMES[DEFAULT_THEME_NAME]) as ThemeJson;
    const resolvedThemeColors = resolveTheme(selectedThemeJson, themeMode);

    return {
      theme: resolvedThemeColors,
      currentThemeName,
      mode: themeMode,
      setTheme(themeName: string, persist = true) {
        if (allThemes[themeName]) {
          setCurrentThemeName(themeName);
          if (persist) persistThemeName(themeName);
        }
      },
      availableThemes(): string[] {
        return Object.keys(allThemes).sort();
      },
    };
  },
});

export type { ThemeColors };
