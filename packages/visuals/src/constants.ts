export const COMP_WIDTH = 1920;
export const COMP_HEIGHT = 1080;
export const FPS = 30;

export const COLORS = {
  bg: "#0a0a0a",
  panel: "#141414",
  element: "#1e1e1e",
  text: "#eeeeee",
  textMuted: "#808080",
  textDim: "#484848",
  border: "#2a2a2a",
  accent: "#FAB283",
  green: "#7fd88f",
  red: "#e06c75",
  blue: "#5c9cf5",
  cyan: "#56b6c2",
};

export const SCENE_DURATIONS = {
  intro: 2.5 * FPS,
  tuiTyping: 8 * FPS,
  daemon: 7 * FPS,
  channels: 7 * FPS,
  eventFlow: 5 * FPS,
  tools: 3 * FPS,
  outro: 2 * FPS,
};

export const TRANSITION_DURATION = 10;

const SCENE_COUNT = Object.keys(SCENE_DURATIONS).length;
export const TOTAL_DURATION =
  Object.values(SCENE_DURATIONS).reduce((a, b) => a + b, 0) -
  (SCENE_COUNT - 1) * TRANSITION_DURATION;
