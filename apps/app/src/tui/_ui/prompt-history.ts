import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const MAX_HISTORY_ENTRIES = 50;

function historyFilePath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".kraken", "state", "prompt-history.jsonl");
}

let loaded: string[] | null = null;

function loadHistory(): string[] {
  if (loaded) return loaded;
  const path = historyFilePath();
  if (!existsSync(path)) {
    loaded = [];
    return loaded;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    loaded = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as string;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is string => entry !== null)
      .slice(-MAX_HISTORY_ENTRIES);
    return loaded;
  } catch {
    loaded = [];
    return loaded;
  }
}

function saveHistory(entries: string[]): void {
  const path = historyFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, content);
  } catch {
    // non-critical
  }
}

export function appendToHistory(input: string): void {
  const trimmed = input.trim();
  if (!trimmed) return;

  const history = loadHistory();
  const lastEntry = history[history.length - 1];
  if (lastEntry === trimmed) return;

  history.push(trimmed);
  if (history.length > MAX_HISTORY_ENTRIES) {
    history.splice(0, history.length - MAX_HISTORY_ENTRIES);
  }
  loaded = history;
  saveHistory(history);
}

export function createHistoryNavigator() {
  let index = 0;
  let savedInput = "";

  return {
    move(direction: -1 | 1, currentInput: string): string | null {
      const history = loadHistory();
      if (history.length === 0) return null;

      if (index === 0 && direction === -1) {
        savedInput = currentInput;
      }

      const newIndex = index + direction;

      if (direction === 1 && newIndex > 0) return null;
      if (direction === -1 && Math.abs(newIndex) > history.length) return null;

      index = newIndex;

      if (index === 0) {
        return savedInput;
      }

      const entry = history[history.length + index];
      return entry ?? null;
    },

    reset(): void {
      index = 0;
      savedInput = "";
    },
  };
}
