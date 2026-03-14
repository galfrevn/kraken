import { decode } from "fast-png";
import { readFileSync, existsSync } from "node:fs";

export interface PixelColor {
  r: number;
  g: number;
  b: number;
}

export interface ImagePreviewData {
  pixels: PixelColor[][];
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

function rgbaAt(data: Uint8Array | Uint16Array, index: number, channels: number): PixelColor {
  const base = index * channels;
  return {
    r: data[base]! & 0xff,
    g: data[base + 1]! & 0xff,
    b: data[base + 2]! & 0xff,
  };
}

function nearestNeighborResize(
  sourceData: Uint8Array | Uint16Array,
  sourceWidth: number,
  sourceHeight: number,
  channels: number,
  targetWidth: number,
  targetHeight: number,
): PixelColor[][] {
  const pixels: PixelColor[][] = [];

  for (let y = 0; y < targetHeight; y++) {
    const row: PixelColor[] = [];
    const sourceY = Math.floor((y / targetHeight) * sourceHeight);

    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.floor((x / targetWidth) * sourceWidth);
      const sourceIndex = sourceY * sourceWidth + sourceX;
      row.push(rgbaAt(sourceData, sourceIndex, channels));
    }

    pixels.push(row);
  }

  return pixels;
}

export function loadImagePreview(
  filePath: string,
  maxColumns: number = 60,
): ImagePreviewData | null {
  if (!existsSync(filePath)) return null;

  try {
    const fileBuffer = readFileSync(filePath);
    const decoded = decode(fileBuffer);
    const channels = decoded.channels ?? decoded.data.length / (decoded.width * decoded.height);

    const aspectRatio = decoded.width / decoded.height;
    let previewWidth = Math.min(maxColumns, decoded.width);
    let previewHeight = Math.round(previewWidth / aspectRatio);

    const maxRows = Math.round(maxColumns * 0.75);
    if (previewHeight > maxRows) {
      previewHeight = maxRows;
      previewWidth = Math.round(previewHeight * aspectRatio);
    }

    previewHeight = previewHeight % 2 === 0 ? previewHeight : previewHeight + 1;

    const pixels = nearestNeighborResize(
      decoded.data as Uint8Array,
      decoded.width,
      decoded.height,
      channels,
      previewWidth,
      previewHeight,
    );

    return {
      pixels,
      width: previewWidth,
      height: previewHeight,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
    };
  } catch {
    return null;
  }
}

export function pixelToHex(pixel: PixelColor): string {
  const r = pixel.r.toString(16).padStart(2, "0");
  const g = pixel.g.toString(16).padStart(2, "0");
  const b = pixel.b.toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

interface ColorSegment {
  text: string;
  fg: string;
  bg: string;
}

export function generatePreviewRows(preview: ImagePreviewData): ColorSegment[][] {
  const rows: ColorSegment[][] = [];

  for (let y = 0; y < preview.height; y += 2) {
    const segments: ColorSegment[] = [];
    let currentFg = "";
    let currentBg = "";
    let currentText = "";

    for (let x = 0; x < preview.width; x++) {
      const topPixel = preview.pixels[y]![x]!;
      const bottomPixel =
        y + 1 < preview.height ? preview.pixels[y + 1]![x]! : { r: 0, g: 0, b: 0 };

      const fg = pixelToHex(topPixel);
      const bg = pixelToHex(bottomPixel);

      if (fg === currentFg && bg === currentBg) {
        currentText += "▀";
      } else {
        if (currentText) {
          segments.push({ text: currentText, fg: currentFg, bg: currentBg });
        }
        currentFg = fg;
        currentBg = bg;
        currentText = "▀";
      }
    }

    if (currentText) {
      segments.push({ text: currentText, fg: currentFg, bg: currentBg });
    }

    rows.push(segments);
  }

  return rows;
}
