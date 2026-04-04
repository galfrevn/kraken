import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sessionTable = sqliteTable("session", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default(""),
  agentId: text("agent_id").notNull().default("build"),
  model: text("model").notNull().default(""),
  parentId: text("parent_id"),
  timeCreated: integer("time_created", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  timeUpdated: integer("time_updated", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const messageTable = sqliteTable(
  "message",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    timeCreated: integer("time_created", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("message_session_idx").on(table.sessionId, table.timeCreated)],
);

export const partTable = sqliteTable(
  "part",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messageTable.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["text", "tool-call", "tool-result", "reasoning"] }).notNull(),
    content: text("content").notNull().default(""),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    toolInput: text("tool_input"),
    state: text("state", { enum: ["pending", "running", "completed", "error"] }),
    timeCreated: integer("time_created", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("part_message_idx").on(table.messageId),
    index("part_session_idx").on(table.sessionId),
  ],
);
