import { definePlugin } from "@kraken/sdk";
import type { Tool, PluginContext } from "@kraken/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const IMAGE_MODEL = "google/gemini-2.5-flash-image";

const ASPECT_RATIO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
};

interface OpenRouterImageItem {
  type: string;
  image_url?: { url?: string };
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
      images?: OpenRouterImageItem[];
    };
  }>;
}

const KRAKEN_HOME = resolve(homedir(), ".kraken");

let pluginApiKey: string | undefined;

function resolveApiKey(): string | undefined {
  return pluginApiKey || Bun.env.OPENROUTER_API_KEY;
}

function extractBase64FromDataUrl(dataUrl: string): string {
  return dataUrl.replace(/^data:image\/\w+;base64,/, "");
}

function saveImageToDisk(
  base64Data: string,
  outputDirectory: string,
): { path: string; sizeBytes: number } {
  mkdirSync(outputDirectory, { recursive: true });
  const filename = `image-${Date.now()}.png`;
  const filepath = join(outputDirectory, filename);
  const buffer = Buffer.from(base64Data, "base64");
  writeFileSync(filepath, buffer);
  return { path: filepath, sizeBytes: buffer.byteLength };
}

function findImageInResponse(response: OpenRouterResponse): OpenRouterImageItem | undefined {
  const images = response.choices?.[0]?.message?.images ?? [];
  return images.find((item) => item.type === "image_url" && item.image_url?.url);
}

const generateImageTool: Tool = {
  definition: {
    name: "generateImage",
    description: "Generate images using Google Gemini 2.5 Flash Image model via OpenRouter.",
    parameters: [
      {
        name: "prompt",
        type: "string",
        description: "Text description of the image to generate.",
        required: true,
      },
      {
        name: "aspectRatio",
        type: "string",
        description: "Aspect ratio: '1:1', '16:9', '9:16', '4:3', '3:4'. Default: '1:1'.",
        required: false,
      },
    ],
  },

  async execute(parameters) {
    const prompt = parameters["prompt"] as string;
    const aspectRatio = (parameters["aspectRatio"] as string) ?? "1:1";
    const dimensions = ASPECT_RATIO_DIMENSIONS[aspectRatio] ?? ASPECT_RATIO_DIMENSIONS["1:1"]!;

    const apiKey = resolveApiKey();
    if (!apiKey) {
      return {
        success: false,
        output:
          "OpenRouter API key not configured. Set apiKey in plugin config or OPENROUTER_API_KEY env variable.",
      };
    }

    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://kraken.ai",
          "X-Title": "Kraken AI Agent",
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          image_config: { width: dimensions.width, height: dimensions.height },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          output: `OpenRouter API error (${response.status}): ${errorBody}`,
        };
      }

      const data = (await response.json()) as OpenRouterResponse;
      const textContent = data.choices?.[0]?.message?.content;
      const imageItem = findImageInResponse(data);

      if (!imageItem?.image_url?.url) {
        const fallback =
          typeof textContent === "string" && textContent.trim()
            ? textContent.trim()
            : "Image generation completed but no image data was returned.";
        return { success: true, output: fallback };
      }

      const base64Data = extractBase64FromDataUrl(imageItem.image_url.url);
      const outputDirectory = join(KRAKEN_HOME, "images");
      const { path, sizeBytes } = saveImageToDisk(base64Data, outputDirectory);

      const description =
        typeof textContent === "string" && textContent.trim() ? textContent.trim() : undefined;

      return {
        success: true,
        output: JSON.stringify({
          type: "image",
          path,
          prompt,
          description,
          aspectRatio,
          width: dimensions.width,
          height: dimensions.height,
          sizeBytes,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to generate image: ${message}` };
    }
  },
};

export default definePlugin({
  name: "nanobanana",
  version: "0.2.0",
  description: "Generate images using Google Gemini 2.5 Flash Image model via OpenRouter.",
  author: "Valen",
  toolDisplayNames: { generateImage: "Generate Image" },

  configSchema: {
    apiKey: {
      type: "string",
      description: "OpenRouter API key for image generation.",
      required: false,
    },
  },

  tools: [generateImageTool],

  hooks: {
    afterToolCall: async (toolName, _parameters, result) => {
      if (result.success) {
        console.log(`[nanobanana] tool "${toolName}" completed successfully`);
      }
    },
  },

  promptExtension:
    "You have access to the 'generateImage' tool from the nanobanana plugin. " +
    "Use it when the user wants to generate images. " +
    'The tool accepts a "prompt" (required) and optionally "aspectRatio" (1:1, 16:9, 9:16, 4:3, 3:4).',

  activate: async (context: PluginContext) => {
    pluginApiKey = context.config.apiKey as string | undefined;
    console.log("[nanobanana] activated");
  },

  deactivate: async () => {
    console.log("[nanobanana] deactivated");
  },
});
