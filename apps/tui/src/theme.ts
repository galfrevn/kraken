export const COLORS = {
  background: "#0d1117",
  backgroundDeep: "#080b10",
  surface: "#161b22",
  card: "#131920",
  inputBackground: "#1c2028",
  border: "#30363d",
  borderFocused: "#58a6ff",

  text: "#e6edf3",
  textSecondary: "#8b949e",
  textMuted: "#484f58",

  green: "#3fb950",
  red: "#f85149",
  yellow: "#d29922",
  blue: "#58a6ff",
  purple: "#bc8cff",
  cyan: "#39d2c0",

  diffAddedBg: "#1a2e1a",
  diffRemovedBg: "#2e1a1a",
} as const;

export const STATUS_COLORS: Record<string, string> = {
  pending: COLORS.yellow,
  running: COLORS.blue,
  completed: COLORS.green,
  failed: COLORS.red,
  cancelled: COLORS.textMuted,
};

export const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  running: "▶",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
};
