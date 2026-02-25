const BACKGROUND = { r: 13, g: 17, b: 23 };

const PALETTE: Record<string, { r: number; g: number; b: number }> = {
  "#58a6ff": { r: 88, g: 166, b: 255 },
  "#1f6feb": { r: 31, g: 111, b: 235 },
  "#e6edf3": { r: 230, g: 237, b: 243 },
  "#8b949e": { r: 139, g: 148, b: 158 },
  "#484f58": { r: 72, g: 79, b: 88 },
  "#39d2c0": { r: 57, g: 210, b: 192 },
};

type PixelRow = string[];
type Frame = PixelRow[];

const _ = "";
const B = "#58a6ff";
const D = "#1f6feb";
const E = "#e6edf3";
const A = "#1f6feb";
const G = "#58a6ff";

const THINKING_FRAMES: Frame[] = [
  [
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
  ],
  [
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
  ],
  [
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
  ],
];

const DOTS_SEQUENCE = ["   ", ".  ", ".. ", "..."];

function ansiColor(r: number, g: number, b: number, isForeground: boolean): string {
  return `\x1b[${isForeground ? 38 : 48};2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const BG = ansiColor(BACKGROUND.r, BACKGROUND.g, BACKGROUND.b, false);
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

function renderFrame(frame: Frame, terminalColumns: number, terminalRows: number): string {
  const avatarWidth = frame[0]?.length ?? 10;
  const avatarHeight = Math.ceil(frame.length / 2);

  const statusText = "starting services";
  const totalContentHeight = avatarHeight + 3;

  const topPadding = Math.max(0, Math.floor((terminalRows - totalContentHeight) / 2));
  const leftPadding = Math.max(0, Math.floor((terminalColumns - avatarWidth) / 2));
  const statusLeftPadding = Math.max(0, Math.floor((terminalColumns - statusText.length - 3) / 2));

  const lines: string[] = [];

  const emptyLine = `${BG}${" ".repeat(terminalColumns)}${RESET}`;

  for (let i = 0; i < topPadding; i++) {
    lines.push(emptyLine);
  }

  for (let y = 0; y < frame.length; y += 2) {
    let line = `${BG}${" ".repeat(leftPadding)}`;

    for (let x = 0; x < avatarWidth; x++) {
      const topPixel = frame[y]?.[x] ?? "";
      const bottomPixel = frame[y + 1]?.[x] ?? "";

      if (!topPixel && !bottomPixel) {
        line += " ";
      } else if (topPixel && !bottomPixel) {
        const color = PALETTE[topPixel];
        if (color) {
          line += `${ansiColor(color.r, color.g, color.b, true)}▀${RESET}${BG}`;
        } else {
          line += " ";
        }
      } else if (!topPixel && bottomPixel) {
        const color = PALETTE[bottomPixel];
        if (color) {
          line += `${ansiColor(color.r, color.g, color.b, true)}▄${RESET}${BG}`;
        } else {
          line += " ";
        }
      } else {
        const topColor = PALETTE[topPixel];
        const bottomColor = PALETTE[bottomPixel];
        if (topColor && bottomColor) {
          line += `${ansiColor(topColor.r, topColor.g, topColor.b, true)}${ansiColor(bottomColor.r, bottomColor.g, bottomColor.b, false)}▀${RESET}${BG}`;
        } else {
          line += " ";
        }
      }
    }

    const renderedAvatarLineLength = leftPadding + avatarWidth;
    const remainingRight = Math.max(0, terminalColumns - renderedAvatarLineLength);
    line += `${" ".repeat(remainingRight)}${RESET}`;
    lines.push(line);
  }

  lines.push(emptyLine);

  const dotIndex = Math.floor(Date.now() / 400) % DOTS_SEQUENCE.length;
  const dots = DOTS_SEQUENCE[dotIndex]!;
  const { r: sr, g: sg, b: sb } = PALETTE["#484f58"]!;
  const statusLine = `${BG}${" ".repeat(statusLeftPadding)}${ansiColor(sr, sg, sb, true)}${statusText}${dots}${RESET}${BG}${" ".repeat(Math.max(0, terminalColumns - statusLeftPadding - statusText.length - 3))}${RESET}`;
  lines.push(statusLine);

  const renderedHeight = lines.length;
  const bottomPadding = Math.max(0, terminalRows - renderedHeight);
  for (let i = 0; i < bottomPadding; i++) {
    lines.push(emptyLine);
  }

  return lines.join("\n");
}

export function startSplashScreen(): { stop: () => void } {
  const columns = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  let frameIndex = 0;

  process.stdout.write(ENTER_ALT_SCREEN);
  process.stdout.write(HIDE_CURSOR);

  const renderCurrentFrame = (): void => {
    const frame = THINKING_FRAMES[frameIndex % THINKING_FRAMES.length]!;
    const output = renderFrame(frame, columns, rows);
    process.stdout.write(`\x1b[H${output}`);
  };

  renderCurrentFrame();

  const animationTimer = setInterval(() => {
    frameIndex++;
    renderCurrentFrame();
  }, 350);

  const dotsTimer = setInterval(() => {
    const frame = THINKING_FRAMES[frameIndex % THINKING_FRAMES.length]!;
    const output = renderFrame(frame, columns, rows);
    process.stdout.write(`\x1b[H${output}`);
  }, 400);

  return {
    stop: () => {
      clearInterval(animationTimer);
      clearInterval(dotsTimer);
      process.stdout.write(SHOW_CURSOR);
      process.stdout.write(EXIT_ALT_SCREEN);
    },
  };
}
