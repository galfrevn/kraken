import { useState, useEffect, useRef } from "react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";

const SSE_DATA_PREFIX_LENGTH = 6;
const SSE_RECONNECT_DELAY_MILLISECONDS = 2000;

type SseEventHandler = (eventType: string, eventData: unknown) => void;

export const { Provider: SdkProvider, use: useSdk } = createSimpleContext({
  name: "Sdk",
  init: () => {
    const serverPort = process.env.KRAKEN_APP_PORT ?? "7899";
    const baseUrl = `http://localhost:${serverPort}`;

    const [isConnected, setIsConnected] = useState(false);
    const sseEventHandlersRef = useRef(new Set<SseEventHandler>());
    const sseAbortControllerRef = useRef<AbortController | null>(null);

    const client = {
      baseUrl,
      async fetch(path: string, options?: RequestInit): Promise<Response> {
        return fetch(`${baseUrl}${path}`, options);
      },
      async post(path: string, body?: unknown): Promise<Response> {
        return fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
      },
    };

    useEffect(() => {
      let mounted = true;

      async function connectSse() {
        if (!mounted) return;

        sseAbortControllerRef.current = new AbortController();
        try {
          const response = await fetch(`${baseUrl}/event`, {
            signal: sseAbortControllerRef.current.signal,
          });

          if (!response.ok || !response.body) return;
          if (mounted) setIsConnected(true);

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            let currentEventType = "message";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                const rawData = line.slice(SSE_DATA_PREFIX_LENGTH);
                if (!rawData) continue;
                try {
                  const parsedData = JSON.parse(rawData);
                  for (const handler of sseEventHandlersRef.current) {
                    handler(currentEventType, parsedData);
                  }
                } catch {}
                currentEventType = "message";
              }
            }
          }
        } catch {
          if (mounted) setIsConnected(false);
        }

        if (mounted) setTimeout(connectSse, SSE_RECONNECT_DELAY_MILLISECONDS);
      }

      connectSse();

      return () => {
        mounted = false;
        sseAbortControllerRef.current?.abort();
      };
    }, []);

    return {
      client,
      isConnected,
      onEvent(handler: SseEventHandler): () => void {
        sseEventHandlersRef.current.add(handler);
        return () => sseEventHandlersRef.current.delete(handler);
      },
    };
  },
});
