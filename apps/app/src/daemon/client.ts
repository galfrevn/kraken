import { DaemonClient } from "@kraken/sdk";
import { loadConfig, onConfigReset } from "@/config/index.ts";

let cachedClient: DaemonClient | null = null;

onConfigReset(() => {
  cachedClient = null;
});

export function getDaemon(): DaemonClient {
  if (cachedClient) return cachedClient;
  cachedClient = new DaemonClient(loadConfig().daemonUrl);
  return cachedClient;
}
