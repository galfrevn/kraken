import { useState, useEffect, useMemo } from "react";

export type AvatarState = "idle" | "thinking" | "working" | "done";

const TRANSPARENT = "";

const PALETTE = {
  body: "#58a6ff",
  bodyDark: "#1f6feb",
  eye: "#e6edf3",
  eyeDark: "#8b949e",
  screen: "#58a6ff",
  screenDim: "#238636",
  accent: "#1f6feb",
  cheek: "#f778ba",
} as const;

type PixelGrid = (string | "")[][];

function makeFrame(rows: (string | "")[][]): PixelGrid {
  return rows;
}

const _ = TRANSPARENT;
const B = PALETTE.body;
const D = PALETTE.bodyDark;
const E = PALETTE.eye;
const G = PALETTE.screen;
const A = PALETTE.accent;

const IDLE_FRAME_1: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, E, B, B, E, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, D, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const IDLE_FRAME_2: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, D, B, B, D, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, D, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const THINKING_FRAME_1: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, E, B, B, B, E, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, D, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const THINKING_FRAME_2: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, B, E, B, B, E, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, D, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const THINKING_FRAME_3: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, D, B, B, D, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, D, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const S = PALETTE.eye;

const WORKING_FRAME_1: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, E, B, B, E, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, S, G, S, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, _, _, _, D, _, _, _],
  [_, _, _, D, _, _, _, D, _, _],
]);

const WORKING_FRAME_2: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, E, B, B, E, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, S, G, S, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, _, D, _, _],
  [_, _, D, _, _, _, D, _, _, _],
]);

const WORKING_FRAME_3: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, E, B, B, E, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, S, S, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, _, D, D, _, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const WORKING_FRAME_4: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, B, E, B, B, E, B, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, S, S, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, _, _, _, D, _, _, _],
  [_, _, _, D, _, _, _, D, _, _],
]);

const C = PALETTE.cheek;

const DONE_FRAME_1: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, C, E, B, B, E, C, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, D, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const DONE_FRAME_2: PixelGrid = makeFrame([
  [_, _, _, _, _, _, _, _, _, _],
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, C, E, B, B, E, C, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, _, _, _, _, D, _, _],
  [_, _, _, _, _, _, _, _, _, _],
]);

const DONE_FRAME_3: PixelGrid = makeFrame([
  [_, _, _, A, A, A, A, _, _, _],
  [_, _, B, B, B, B, B, B, _, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, B, C, E, B, B, E, C, B, _],
  [_, B, B, B, B, B, B, B, B, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, D, G, G, G, G, D, _, _],
  [_, _, D, D, D, D, D, D, _, _],
  [_, _, _, D, _, _, D, _, _, _],
  [_, _, _, D, _, _, D, _, _, _],
]);

const ANIMATION_FRAMES: Record<AvatarState, PixelGrid[]> = {
  idle: [IDLE_FRAME_1, IDLE_FRAME_1, IDLE_FRAME_2, IDLE_FRAME_2],
  thinking: [THINKING_FRAME_1, THINKING_FRAME_2, THINKING_FRAME_3, THINKING_FRAME_2],
  working: [WORKING_FRAME_1, WORKING_FRAME_2, WORKING_FRAME_3, WORKING_FRAME_4],
  done: [DONE_FRAME_1, DONE_FRAME_2, DONE_FRAME_3, DONE_FRAME_2],
};

const ANIMATION_SPEED_MILLISECONDS: Record<AvatarState, number> = {
  idle: 600,
  thinking: 350,
  working: 150,
  done: 200,
};

interface PixelSegment {
  character: string;
  foreground: string;
  background: string;
}

function renderFrameToRows(frame: PixelGrid): PixelSegment[][] {
  const rows: PixelSegment[][] = [];
  const height = frame.length;
  const width = frame[0]?.length ?? 0;

  for (let y = 0; y < height; y += 2) {
    const row: PixelSegment[] = [];

    for (let x = 0; x < width; x++) {
      const topColor = frame[y]?.[x] ?? TRANSPARENT;
      const bottomColor = frame[y + 1]?.[x] ?? TRANSPARENT;

      if (topColor === TRANSPARENT && bottomColor === TRANSPARENT) {
        row.push({ character: " ", foreground: "", background: "" });
      } else if (topColor !== TRANSPARENT && bottomColor === TRANSPARENT) {
        row.push({ character: "▀", foreground: topColor, background: "" });
      } else if (topColor === TRANSPARENT && bottomColor !== TRANSPARENT) {
        row.push({ character: "▄", foreground: bottomColor, background: "" });
      } else {
        row.push({ character: "▀", foreground: topColor, background: bottomColor });
      }
    }

    rows.push(row);
  }

  return rows;
}

interface RenderGroup {
  text: string;
  foreground: string;
  background: string;
}

function groupSegments(segments: PixelSegment[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let currentGroup: RenderGroup | null = null;

  for (const segment of segments) {
    if (
      currentGroup &&
      currentGroup.foreground === segment.foreground &&
      currentGroup.background === segment.background
    ) {
      currentGroup.text += segment.character;
    } else {
      currentGroup = {
        text: segment.character,
        foreground: segment.foreground,
        background: segment.background,
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}

interface AvatarProps {
  state: AvatarState;
}

export function Avatar({ state }: AvatarProps) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
  }, [state]);

  useEffect(() => {
    // Idle animation is subtle (just an eye blink) — skip the timer to avoid
    // re-renders that cause the nearby textarea cursor to flicker.
    if (state === "idle") return;

    const speed = ANIMATION_SPEED_MILLISECONDS[state];
    const timer = setInterval(() => {
      setFrameIndex((previous) => previous + 1);
    }, speed);
    return () => clearInterval(timer);
  }, [state]);

  const frames = ANIMATION_FRAMES[state];
  const currentFrame = frames[frameIndex % frames.length]!;

  const renderedRows = useMemo(() => {
    return renderFrameToRows(currentFrame);
  }, [currentFrame]);

  return (
    <box flexDirection="column">
      {renderedRows.map((row, rowIndex) => {
        const groups = groupSegments(row);
        return (
          <box flexDirection="row" key={rowIndex}>
            {groups.map((group, groupIndex) => (
              <text
                key={groupIndex}
                fg={group.foreground || undefined}
                bg={group.background || undefined}
              >
                {group.text}
              </text>
            ))}
          </box>
        );
      })}
    </box>
  );
}
