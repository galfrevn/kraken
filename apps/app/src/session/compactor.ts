import { eq } from "drizzle-orm";
import type { CoreMessage } from "ai";
import { getDatabase } from "@/storage/db.ts";
import { sessionTable } from "@/storage/schema.ts";
import { Session } from "@/session/index.ts";
import { generatePlainText } from "@/session/llm.ts";
import { Bus, Events } from "@/bus/index.ts";

const SUMMARIZER_SYSTEM_PROMPT = `You are a conversation summarizer for a software development assistant.
Generate a detailed but concise summary of the conversation. Include:
- What was accomplished and key decisions made
- Files being worked on and their current state
- Problems encountered and how they were resolved
- The current task and next steps
The summary must be sufficient to continue the conversation without losing context.`;

const SUMMARIZE_USER_PROMPT =
  "Summarize our conversation above. Focus on what's needed to continue working: what we did, what we're doing, which files we touched, and what's next.";

export async function compactSession(sessionId: string, messages: CoreMessage[]): Promise<void> {
  if (messages.length < 4) return;

  Bus.publish(Events.Session.Compacting, { sessionId });

  const messagesWithSummarizeRequest: CoreMessage[] = [
    ...messages,
    { role: "user", content: SUMMARIZE_USER_PROMPT },
  ];

  const summaryText = await generatePlainText({
    system: SUMMARIZER_SYSTEM_PROMPT,
    messages: messagesWithSummarizeRequest,
  });

  if (!summaryText) {
    return;
  }

  const summaryMessage = Session.addMessage(
    sessionId,
    "assistant",
    `[Conversation Summary]\n\n${summaryText}`,
  );

  const database = getDatabase();
  database
    .update(sessionTable)
    .set({ summaryMessageId: summaryMessage.id, timeUpdated: new Date() })
    .where(eq(sessionTable.id, sessionId))
    .run();

  Bus.publish(Events.Session.Compacted, { sessionId });
}
