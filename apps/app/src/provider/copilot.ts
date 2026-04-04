import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";
import { loadAuth, saveAuth, hasAuth } from "./auth.ts";
import type { ModelInfo } from "@/models/types.ts";

const COPILOT_CLIENT_ID = "Iv23libWXQ5jqeD4k0DL";
const COPILOT_BASE_URL = "https://api.githubcopilot.com";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const POLL_TIMEOUT_MS = 300_000;

interface DeviceCodeResponse {
  verification_uri: string;
  user_code: string;
  device_code: string;
  interval: number;
}

export function isCopilotConfigured(): boolean {
  return hasAuth("copilot");
}

export async function copilotDeviceCodeFlow(): Promise<string> {
  const deviceResponse = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!deviceResponse.ok) {
    throw new Error(`Device code request failed: ${deviceResponse.status}`);
  }

  const deviceData = (await deviceResponse.json()) as DeviceCodeResponse;

  console.log(`\nGo to: ${deviceData.verification_uri}`);
  console.log(`Enter code: ${deviceData.user_code}\n`);

  const startTime = Date.now();
  let interval = (deviceData.interval || 5) * 1000 + 1000;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    const tokenResponse = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const tokenData = (await tokenResponse.json()) as Record<string, unknown>;

    if (tokenData.access_token) {
      const token = tokenData.access_token as string;
      saveAuth("copilot", {
        type: "oauth",
        access_token: token,
        provider: "copilot",
      });
      return token;
    }

    if (tokenData.error === "slow_down") {
      interval += 5000;
    } else if (tokenData.error !== "authorization_pending") {
      throw new Error(`OAuth error: ${tokenData.error}`);
    }
  }

  throw new Error("OAuth flow timed out");
}

export async function copilotListModels(): Promise<ModelInfo[]> {
  const auth = loadAuth("copilot");
  if (!auth) return [];

  try {
    const response = await fetch(`${COPILOT_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        "User-Agent": "kraken",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as {
      data: Array<{
        id: string;
        name: string;
        model_picker_enabled?: boolean;
        capabilities?: {
          limits?: {
            max_context_window_tokens?: number;
          };
          supports?: {
            tool_calls?: boolean;
          };
        };
      }>;
    };

    return data.data.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      providerId: "copilot",
      providerName: "GitHub Copilot",
      contextLength: m.capabilities?.limits?.max_context_window_tokens,
    }));
  } catch {
    return [];
  }
}

export function createCopilotModel(modelId: string): LanguageModelV1 {
  const auth = loadAuth("copilot");
  if (!auth) throw new Error("Copilot not authenticated. Run: kraken provider configure copilot");

  const client = createOpenAI({
    apiKey: auth.access_token,
    baseURL: `${COPILOT_BASE_URL}`,
    headers: {
      "Copilot-Vision-Request": "true",
      "Openai-Intent": "conversation-edits",
    },
  });

  return client(modelId);
}
