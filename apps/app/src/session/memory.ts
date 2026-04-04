import { basename } from "node:path";
import { getDaemon } from "@/daemon/client.ts";
import { Session } from "@/session/index.ts";

let activeMemorySessionId: string | null = null;

function getProjectName(): string {
  return basename(process.cwd());
}

export async function startMemorySession(sessionId: string): Promise<void> {
  if (activeMemorySessionId && activeMemorySessionId !== sessionId) {
    await endMemorySession();
  }

  try {
    await getDaemon().memory.sessions.start({
      id: sessionId,
      project: getProjectName(),
      directory: process.cwd(),
    });
    activeMemorySessionId = sessionId;
  } catch {
    // daemon not running -- silently skip
  }
}

export async function endMemorySession(): Promise<void> {
  if (!activeMemorySessionId) return;

  const sessionId = activeMemorySessionId;

  const session = Session.get(sessionId);
  const summary = session?.title || "Session ended without summary";

  try {
    await getDaemon().memory.sessions.end(sessionId, { summary });
  } catch {
    // daemon not running -- silently skip
  }

  // Clear after the call so we can retry if it fails
  activeMemorySessionId = null;
}

export function getActiveMemorySessionId(): string | null {
  return activeMemorySessionId;
}
