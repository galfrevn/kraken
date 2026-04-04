import type { ThemeColors, ThemeJson, ColorValue } from "@/tui/_theme/types.ts";

const KEY_ALIASES: Record<string, string> = {
  diffAddedBg: "diffAddedBackground",
  diffRemovedBg: "diffRemovedBackground",
  diffContextBg: "diffContextBackground",
  diffAddedLineNumberBg: "diffAddedLineNumberBackground",
  diffRemovedLineNumberBg: "diffRemovedLineNumberBackground",
};

const OPTIONAL_KEYS = new Set(["backgroundMenu", "$schema"]);

export function resolveTheme(themeJson: ThemeJson, mode: "dark" | "light"): ThemeColors {
  const definitions = themeJson.defs ?? {};

  function resolveColor(colorValue: ColorValue): string {
    if (typeof colorValue === "string") {
      if (colorValue.startsWith("#")) return colorValue;
      if (definitions[colorValue] !== undefined) {
        return resolveColor(definitions[colorValue]);
      }
      if (themeJson.theme[colorValue as keyof typeof themeJson.theme] !== undefined) {
        return resolveColor(
          themeJson.theme[colorValue as keyof typeof themeJson.theme] as ColorValue,
        );
      }
      return colorValue;
    }
    return resolveColor(colorValue[mode]);
  }

  const rawTheme = themeJson.theme as Record<string, ColorValue>;
  const resolvedEntries: Array<[string, string]> = [];

  for (const [rawKey, colorValue] of Object.entries(rawTheme)) {
    if (OPTIONAL_KEYS.has(rawKey)) continue;
    const normalizedKey = KEY_ALIASES[rawKey] ?? rawKey;
    resolvedEntries.push([normalizedKey, resolveColor(colorValue)]);
  }

  const resolved = Object.fromEntries(resolvedEntries) as ThemeColors;

  if (!resolved.backgroundMenu) {
    resolved.backgroundMenu = resolved.backgroundElement;
  }

  return resolved;
}
