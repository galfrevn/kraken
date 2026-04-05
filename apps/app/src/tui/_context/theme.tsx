import { useState, useEffect } from "react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";
import { resolveTheme } from "@/tui/_theme/resolver.ts";
import type { ThemeColors, ThemeJson } from "@/tui/_theme/types.ts";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Static imports so the bundler embeds theme JSON into the bundle
import themeAura from "@/tui/_theme/aura.json";
import themeAyu from "@/tui/_theme/ayu.json";
import themeCarbonfox from "@/tui/_theme/carbonfox.json";
import themeCatppuccin from "@/tui/_theme/catppuccin.json";
import themeCatppuccinFrappe from "@/tui/_theme/catppuccin-frappe.json";
import themeCatppuccinMacchiato from "@/tui/_theme/catppuccin-macchiato.json";
import themeCobalt2 from "@/tui/_theme/cobalt2.json";
import themeCursor from "@/tui/_theme/cursor.json";
import themeDracula from "@/tui/_theme/dracula.json";
import themeEverforest from "@/tui/_theme/everforest.json";
import themeFlexoki from "@/tui/_theme/flexoki.json";
import themeGithub from "@/tui/_theme/github.json";
import themeGruvbox from "@/tui/_theme/gruvbox.json";
import themeKanagawa from "@/tui/_theme/kanagawa.json";
import themeKraken from "@/tui/_theme/kraken.json";
import themeLucentOrng from "@/tui/_theme/lucent-orng.json";
import themeMaterial from "@/tui/_theme/material.json";
import themeMatrix from "@/tui/_theme/matrix.json";
import themeMercury from "@/tui/_theme/mercury.json";
import themeMonokai from "@/tui/_theme/monokai.json";
import themeNightowl from "@/tui/_theme/nightowl.json";
import themeNord from "@/tui/_theme/nord.json";
import themeOneDark from "@/tui/_theme/one-dark.json";
import themeOpencode from "@/tui/_theme/opencode.json";
import themeOrng from "@/tui/_theme/orng.json";
import themeOsakaJade from "@/tui/_theme/osaka-jade.json";
import themePalenight from "@/tui/_theme/palenight.json";
import themeRosepine from "@/tui/_theme/rosepine.json";
import themeSolarized from "@/tui/_theme/solarized.json";
import themeSynthwave84 from "@/tui/_theme/synthwave84.json";
import themeTokyonight from "@/tui/_theme/tokyonight.json";
import themeVercel from "@/tui/_theme/vercel.json";
import themeVesper from "@/tui/_theme/vesper.json";
import themeZenburn from "@/tui/_theme/zenburn.json";

const DEFAULT_THEME_NAME = "kraken";

const BUILTIN_THEMES: Record<string, ThemeJson> = {
  aura: themeAura as ThemeJson,
  ayu: themeAyu as ThemeJson,
  carbonfox: themeCarbonfox as ThemeJson,
  catppuccin: themeCatppuccin as ThemeJson,
  "catppuccin-frappe": themeCatppuccinFrappe as ThemeJson,
  "catppuccin-macchiato": themeCatppuccinMacchiato as ThemeJson,
  cobalt2: themeCobalt2 as ThemeJson,
  cursor: themeCursor as ThemeJson,
  dracula: themeDracula as ThemeJson,
  everforest: themeEverforest as ThemeJson,
  flexoki: themeFlexoki as ThemeJson,
  github: themeGithub as ThemeJson,
  gruvbox: themeGruvbox as ThemeJson,
  kanagawa: themeKanagawa as ThemeJson,
  kraken: themeKraken as ThemeJson,
  "lucent-orng": themeLucentOrng as ThemeJson,
  material: themeMaterial as ThemeJson,
  matrix: themeMatrix as ThemeJson,
  mercury: themeMercury as ThemeJson,
  monokai: themeMonokai as ThemeJson,
  nightowl: themeNightowl as ThemeJson,
  nord: themeNord as ThemeJson,
  "one-dark": themeOneDark as ThemeJson,
  opencode: themeOpencode as ThemeJson,
  orng: themeOrng as ThemeJson,
  "osaka-jade": themeOsakaJade as ThemeJson,
  palenight: themePalenight as ThemeJson,
  rosepine: themeRosepine as ThemeJson,
  solarized: themeSolarized as ThemeJson,
  synthwave84: themeSynthwave84 as ThemeJson,
  tokyonight: themeTokyonight as ThemeJson,
  vercel: themeVercel as ThemeJson,
  vesper: themeVesper as ThemeJson,
  zenburn: themeZenburn as ThemeJson,
};

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
