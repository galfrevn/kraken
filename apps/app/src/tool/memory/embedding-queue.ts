import { generateEmbedding } from "@/provider/embedding.ts";
import { getDaemon } from "@/daemon/client.ts";
import { basename } from "node:path";

interface PendingEmbedding {
  title: string;
  content: string;
  type: string;
  scope?: string;
  topicKey?: string;
  sessionId: string;
  retryCount: number;
  nextRetryAt: number;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MILLISECONDS = 5_000;
const pendingQueue: PendingEmbedding[] = [];
let processingInterval: ReturnType<typeof setInterval> | null = null;

export function scheduleEmbeddingRetry(
  entry: Omit<PendingEmbedding, "retryCount" | "nextRetryAt">,
) {
  pendingQueue.push({
    ...entry,
    retryCount: 0,
    nextRetryAt: Date.now() + BASE_DELAY_MILLISECONDS,
  });

  if (!processingInterval) {
    processingInterval = setInterval(processQueue, BASE_DELAY_MILLISECONDS);
  }
}

async function processQueue() {
  if (pendingQueue.length === 0) {
    if (processingInterval) {
      clearInterval(processingInterval);
      processingInterval = null;
    }
    return;
  }

  const now = Date.now();
  const ready = pendingQueue.filter((entry) => entry.nextRetryAt <= now);

  for (const entry of ready) {
    const index = pendingQueue.indexOf(entry);
    if (index === -1) continue;

    try {
      const embedding = await generateEmbedding(`${entry.title} ${entry.content}`);
      if (embedding) {
        await getDaemon().memory.observations.create({
          session_id: entry.sessionId,
          type: entry.type,
          title: entry.title,
          content: entry.content,
          project: basename(process.cwd()),
          scope: entry.scope as "project" | "personal" | undefined,
          topic_key: entry.topicKey,
          embedding,
        });
        pendingQueue.splice(index, 1);
      } else {
        retryOrDrop(entry, index);
      }
    } catch {
      retryOrDrop(entry, index);
    }
  }
}

function retryOrDrop(entry: PendingEmbedding, index: number) {
  entry.retryCount++;
  if (entry.retryCount >= MAX_RETRIES) {
    pendingQueue.splice(index, 1);
    return;
  }
  const delay = BASE_DELAY_MILLISECONDS * 2 ** entry.retryCount;
  entry.nextRetryAt = Date.now() + delay;
}

export function getPendingEmbeddingCount(): number {
  return pendingQueue.length;
}
