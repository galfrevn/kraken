import { eq, desc, isNull } from "drizzle-orm";
import { getDatabase } from "@/storage/db.ts";
import { sessionTable, messageTable, partTable } from "@/storage/schema.ts";
import { Bus, Events } from "@/bus/index.ts";

function generateId(): string {
  return crypto.randomUUID();
}

interface CreateSessionOptions {
  agentId?: string;
  model?: string;
  parentId?: string;
  title?: string;
}

export const Session = {
  create(agentIdOrOptions?: string | CreateSessionOptions, model?: string) {
    const database = getDatabase();
    const sessionId = generateId();
    const now = new Date();

    let agentId = "build";
    let modelValue = "";
    let parentId: string | null = null;
    let title = "";

    if (typeof agentIdOrOptions === "string") {
      agentId = agentIdOrOptions;
      modelValue = model ?? "";
    } else if (agentIdOrOptions) {
      agentId = agentIdOrOptions.agentId ?? "build";
      modelValue = agentIdOrOptions.model ?? "";
      parentId = agentIdOrOptions.parentId ?? null;
      title = agentIdOrOptions.title ?? "";
    }

    const insertedRows = database
      .insert(sessionTable)
      .values({
        id: sessionId,
        agentId,
        model: modelValue,
        parentId,
        title,
        timeCreated: now,
        timeUpdated: now,
      })
      .returning()
      .all();

    const insertedSession = insertedRows[0]!;
    Bus.publish(Events.Session.Created, { sessionId });
    return insertedSession;
  },

  list() {
    const database = getDatabase();
    return database
      .select()
      .from(sessionTable)
      .where(isNull(sessionTable.parentId))
      .orderBy(desc(sessionTable.timeUpdated))
      .all();
  },

  get(sessionId: string) {
    const database = getDatabase();
    const results = database
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, sessionId))
      .all();
    return results[0] ?? null;
  },

  updateTitle(sessionId: string, title: string) {
    const database = getDatabase();
    database
      .update(sessionTable)
      .set({ title, timeUpdated: new Date() })
      .where(eq(sessionTable.id, sessionId))
      .run();

    Bus.publish(Events.Session.Updated, { sessionId });
  },

  delete(sessionId: string) {
    const database = getDatabase();
    database.delete(partTable).where(eq(partTable.sessionId, sessionId)).run();
    database.delete(messageTable).where(eq(messageTable.sessionId, sessionId)).run();
    database.delete(sessionTable).where(eq(sessionTable.id, sessionId)).run();

    Bus.publish(Events.Session.Deleted, { sessionId });
  },

  clearMessages(sessionId: string) {
    const database = getDatabase();
    database.delete(partTable).where(eq(partTable.sessionId, sessionId)).run();
    database.delete(messageTable).where(eq(messageTable.sessionId, sessionId)).run();
    database
      .update(sessionTable)
      .set({ timeUpdated: new Date() })
      .where(eq(sessionTable.id, sessionId))
      .run();

    Bus.publish(Events.Session.Updated, { sessionId });
  },

  getMessages(sessionId: string) {
    const database = getDatabase();
    return database
      .select()
      .from(messageTable)
      .where(eq(messageTable.sessionId, sessionId))
      .orderBy(messageTable.timeCreated)
      .all();
  },

  getParts(messageId: string) {
    const database = getDatabase();
    return database
      .select()
      .from(partTable)
      .where(eq(partTable.messageId, messageId))
      .orderBy(partTable.timeCreated)
      .all();
  },

  getMessagesWithParts(sessionId: string) {
    const database = getDatabase();
    const messages = database
      .select()
      .from(messageTable)
      .where(eq(messageTable.sessionId, sessionId))
      .orderBy(messageTable.timeCreated)
      .all();

    return messages.map((message) => {
      const parts = database
        .select()
        .from(partTable)
        .where(eq(partTable.messageId, message.id))
        .orderBy(partTable.timeCreated)
        .all();
      return { ...message, parts };
    });
  },

  addMessage(sessionId: string, role: "user" | "assistant" | "system", content?: string) {
    const database = getDatabase();
    const messageId = generateId();
    const now = new Date();

    const rawDb = database.$client;
    const transaction = rawDb.transaction(() => {
      database
        .insert(messageTable)
        .values({ id: messageId, sessionId, role, timeCreated: now })
        .run();

      if (content) {
        database
          .insert(partTable)
          .values({
            id: generateId(),
            messageId,
            sessionId,
            type: "text",
            content,
            timeCreated: now,
          })
          .run();
      }

      database
        .update(sessionTable)
        .set({ timeUpdated: now })
        .where(eq(sessionTable.id, sessionId))
        .run();
    });
    transaction();

    const insertedMessage = database
      .select()
      .from(messageTable)
      .where(eq(messageTable.id, messageId))
      .get()!;

    Bus.publish(Events.Message.Created, { sessionId, messageId, role, content: content ?? "" });
    return insertedMessage;
  },
};
