import { RGBA } from "@opentui/core";
import type { ColorInput } from "@opentui/core";
import type { ColorGenerator } from "opentui-spinner";

interface AdvancedGradientOptions {
  colors: ColorInput[];
  trailLength: number;
  defaultColor?: ColorInput;
  direction?: "forward" | "backward" | "bidirectional";
  holdFrames?: { start?: number; end?: number };
  enableFading?: boolean;
  minAlpha?: number;
}

interface ScannerState {
  activePosition: number;
  isHolding: boolean;
  holdProgress: number;
  holdTotal: number;
  movementProgress: number;
  movementTotal: number;
  isMovingForward: boolean;
}

function getScannerState(
  frameIndex: number,
  totalChars: number,
  options: Pick<AdvancedGradientOptions, "direction" | "holdFrames">,
): ScannerState {
  const { direction = "forward", holdFrames = {} } = options;

  if (direction === "bidirectional") {
    const forwardFrames = totalChars;
    const holdEndFrames = holdFrames.end ?? 0;
    const backwardFrames = totalChars - 1;

    if (frameIndex < forwardFrames) {
      return {
        activePosition: frameIndex,
        isHolding: false,
        holdProgress: 0,
        holdTotal: 0,
        movementProgress: frameIndex,
        movementTotal: forwardFrames,
        isMovingForward: true,
      };
    } else if (frameIndex < forwardFrames + holdEndFrames) {
      return {
        activePosition: totalChars - 1,
        isHolding: true,
        holdProgress: frameIndex - forwardFrames,
        holdTotal: holdEndFrames,
        movementProgress: 0,
        movementTotal: 0,
        isMovingForward: true,
      };
    } else if (frameIndex < forwardFrames + holdEndFrames + backwardFrames) {
      const backwardIndex = frameIndex - forwardFrames - holdEndFrames;
      return {
        activePosition: totalChars - 2 - backwardIndex,
        isHolding: false,
        holdProgress: 0,
        holdTotal: 0,
        movementProgress: backwardIndex,
        movementTotal: backwardFrames,
        isMovingForward: false,
      };
    } else {
      return {
        activePosition: 0,
        isHolding: true,
        holdProgress: frameIndex - forwardFrames - holdEndFrames - backwardFrames,
        holdTotal: holdFrames.start ?? 0,
        movementProgress: 0,
        movementTotal: 0,
        isMovingForward: false,
      };
    }
  } else if (direction === "backward") {
    return {
      activePosition: totalChars - 1 - (frameIndex % totalChars),
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frameIndex % totalChars,
      movementTotal: totalChars,
      isMovingForward: false,
    };
  } else {
    return {
      activePosition: frameIndex % totalChars,
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frameIndex % totalChars,
      movementTotal: totalChars,
      isMovingForward: true,
    };
  }
}

function calculateColorIndex(
  frameIndex: number,
  charIndex: number,
  totalChars: number,
  options: Pick<AdvancedGradientOptions, "direction" | "holdFrames" | "trailLength">,
  state?: ScannerState,
): number {
  const { trailLength } = options;
  const { activePosition, isHolding, holdProgress, isMovingForward } =
    state ?? getScannerState(frameIndex, totalChars, options);

  const directionalDistance = isMovingForward
    ? activePosition - charIndex
    : charIndex - activePosition;

  if (isHolding) {
    return directionalDistance + holdProgress;
  }

  if (directionalDistance > 0 && directionalDistance < trailLength) {
    return directionalDistance;
  }

  if (directionalDistance === 0) {
    return 0;
  }

  return -1;
}

function createKnightRiderTrail(options: AdvancedGradientOptions): ColorGenerator {
  const { colors, defaultColor, enableFading = true, minAlpha = 0 } = options;

  const defaultRgba =
    defaultColor instanceof RGBA
      ? defaultColor
      : RGBA.fromHex((defaultColor as string) || "#000000");

  const baseInactiveAlpha = defaultRgba.a;

  let cachedFrameIndex = -1;
  let cachedState: ScannerState | null = null;

  return (frameIndex: number, charIndex: number, _totalFrames: number, totalChars: number) => {
    if (frameIndex !== cachedFrameIndex) {
      cachedFrameIndex = frameIndex;
      cachedState = getScannerState(frameIndex, totalChars, options);
    }

    const state = cachedState!;
    const index = calculateColorIndex(frameIndex, charIndex, totalChars, options, state);
    const { isHolding, holdProgress, holdTotal, movementProgress, movementTotal } = state;

    let fadeFactor = 1.0;
    if (enableFading) {
      if (isHolding && holdTotal > 0) {
        const progress = Math.min(holdProgress / holdTotal, 1);
        fadeFactor = Math.max(minAlpha, 1 - progress * (1 - minAlpha));
      } else if (!isHolding && movementTotal > 0) {
        const progress = Math.min(movementProgress / Math.max(1, movementTotal - 1), 1);
        fadeFactor = minAlpha + progress * (1 - minAlpha);
      }
    }

    defaultRgba.a = baseInactiveAlpha * fadeFactor;

    if (index === -1) {
      return defaultRgba;
    }

    return colors[index] ?? defaultRgba;
  };
}

function deriveTrailColors(brightColor: ColorInput, steps: number = 6): RGBA[] {
  const baseRgba = brightColor instanceof RGBA ? brightColor : RGBA.fromHex(brightColor as string);

  const colors: RGBA[] = [];

  for (let i = 0; i < steps; i++) {
    let alpha: number;
    let brightnessFactor: number;

    if (i === 0) {
      alpha = 1.0;
      brightnessFactor = 1.0;
    } else if (i === 1) {
      alpha = 0.9;
      brightnessFactor = 1.15;
    } else {
      alpha = Math.pow(0.65, i - 1);
      brightnessFactor = 1.0;
    }

    const r = Math.min(1.0, baseRgba.r * brightnessFactor);
    const g = Math.min(1.0, baseRgba.g * brightnessFactor);
    const b = Math.min(1.0, baseRgba.b * brightnessFactor);

    colors.push(RGBA.fromValues(r, g, b, alpha));
  }

  return colors;
}

function deriveInactiveColor(brightColor: ColorInput, factor: number = 0.2): RGBA {
  const baseRgba = brightColor instanceof RGBA ? brightColor : RGBA.fromHex(brightColor as string);
  return RGBA.fromValues(baseRgba.r, baseRgba.g, baseRgba.b, factor);
}

export interface KnightRiderOptions {
  width?: number;
  style?: "blocks" | "diamonds";
  holdStart?: number;
  holdEnd?: number;
  colors?: ColorInput[];
  color?: ColorInput;
  trailSteps?: number;
  defaultColor?: ColorInput;
  inactiveFactor?: number;
  enableFading?: boolean;
  minAlpha?: number;
}

export function createFrames(options: KnightRiderOptions = {}): string[] {
  const width = options.width ?? 8;
  const style = options.style ?? "diamonds";
  const holdStart = options.holdStart ?? 30;
  const holdEnd = options.holdEnd ?? 9;

  const colors =
    options.colors ??
    (options.color
      ? deriveTrailColors(options.color, options.trailSteps)
      : [
          RGBA.fromHex("#ff0000"),
          RGBA.fromHex("#ff5555"),
          RGBA.fromHex("#dd0000"),
          RGBA.fromHex("#aa0000"),
          RGBA.fromHex("#770000"),
          RGBA.fromHex("#440000"),
        ]);

  const defaultColor =
    options.defaultColor ??
    (options.color
      ? deriveInactiveColor(options.color, options.inactiveFactor)
      : RGBA.fromHex("#330000"));

  const trailOptions = {
    colors,
    trailLength: colors.length,
    defaultColor,
    direction: "bidirectional" as const,
    holdFrames: { start: holdStart, end: holdEnd },
    enableFading: options.enableFading,
    minAlpha: options.minAlpha,
  };

  const totalFrames = width + holdEnd + (width - 1) + holdStart;

  const frames = Array.from({ length: totalFrames }, (_, frameIndex) => {
    return Array.from({ length: width }, (_, charIndex) => {
      const index = calculateColorIndex(frameIndex, charIndex, width, trailOptions);

      if (style === "diamonds") {
        const shapes = ["⬥", "◆", "⬩", "⬪"];
        if (index >= 0 && index < trailOptions.colors.length) {
          return shapes[Math.min(index, shapes.length - 1)];
        }
        return "·";
      }

      const isActive = index >= 0 && index < trailOptions.colors.length;
      return isActive ? "■" : "⬝";
    }).join("");
  });

  return frames;
}

export function createColors(options: KnightRiderOptions = {}): ColorGenerator {
  const holdStart = options.holdStart ?? 30;
  const holdEnd = options.holdEnd ?? 9;

  const colors =
    options.colors ??
    (options.color
      ? deriveTrailColors(options.color, options.trailSteps)
      : [
          RGBA.fromHex("#ff0000"),
          RGBA.fromHex("#ff5555"),
          RGBA.fromHex("#dd0000"),
          RGBA.fromHex("#aa0000"),
          RGBA.fromHex("#770000"),
          RGBA.fromHex("#440000"),
        ]);

  const defaultColor =
    options.defaultColor ??
    (options.color
      ? deriveInactiveColor(options.color, options.inactiveFactor)
      : RGBA.fromHex("#330000"));

  const trailOptions = {
    colors,
    trailLength: colors.length,
    defaultColor,
    direction: "bidirectional" as const,
    holdFrames: { start: holdStart, end: holdEnd },
    enableFading: options.enableFading,
    minAlpha: options.minAlpha,
  };

  return createKnightRiderTrail(trailOptions);
}
