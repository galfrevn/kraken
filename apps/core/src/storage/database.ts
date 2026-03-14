import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'medium',
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    approval_policy TEXT NOT NULL DEFAULT 'auto',
    parameters TEXT NOT NULL DEFAULT '{}',
    output TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id)`,
  `CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'new conversation',
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS thread_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    raw_content TEXT,
    tool_name TEXT,
    tool_success INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS thread_conversation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_thread_conversation_thread_id ON thread_conversation(thread_id)`,
  `CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'conversation',
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category)`,
  `DROP TRIGGER IF EXISTS memory_facts_ai`,
  `DROP TRIGGER IF EXISTS memory_facts_ad`,
  `DROP TRIGGER IF EXISTS memory_facts_au`,
  `DROP TABLE IF EXISTS memory_facts_fts`,
  `CREATE TABLE IF NOT EXISTS engine_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL DEFAULT 'info',
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_engine_logs_created_at ON engine_logs(created_at)`,
];

export interface TaskRow {
  id: string;
  name: string;
  description: string;
  status: string;
  priority: string;
  trigger_type: string;
  approval_policy: string;
  parameters: string;
  output: string;
  error_message: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface TaskLogRow {
  id: number;
  task_id: string;
  level: string;
  message: string;
  metadata: string;
  created_at: string;
}

export interface EngineLogRow {
  id: number;
  level: string;
  source: string;
  message: string;
  created_at: string;
}

export interface ThreadRow {
  id: string;
  title: string;
  is_active: number;
  created_at: string;
}

export interface ThreadMessageRow {
  id?: number;
  thread_id?: string;
  role: string;
  content: string;
  raw_content: string | null;
  tool_name: string | null;
  tool_success: number | null;
  created_at: string;
}

export interface ThreadConversationRow {
  id?: number;
  thread_id?: string;
  role: string;
  content: string;
  position: number;
}

export interface MemoryFactRow {
  id: number;
  category: string;
  content: string;
  source: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export class AgentDatabase {
  private database: Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });

    this.database = new Database(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.runMigrations();
  }

  private runMigrations(): void {
    for (const migration of MIGRATIONS) {
      this.database.exec(migration);
    }
  }

  createTask(task: Omit<TaskRow, "created_at" | "started_at" | "completed_at">): TaskRow {
    const statement = this.database.prepare(`
      INSERT INTO tasks (id, name, description, status, priority, trigger_type, approval_policy, parameters, output, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    statement.run(
      task.id,
      task.name,
      task.description,
      task.status,
      task.priority,
      task.trigger_type,
      task.approval_policy,
      task.parameters,
      task.output,
      task.error_message,
    );

    return this.getTask(task.id)!;
  }

  getTask(taskId: string): TaskRow | undefined {
    const statement = this.database.prepare("SELECT * FROM tasks WHERE id = ?");
    return statement.get(taskId) as TaskRow | undefined;
  }

  listTasks(filters?: {
    status?: string;
    triggerType?: string;
    limit?: number;
    offset?: number;
  }): TaskRow[] {
    let query = "SELECT * FROM tasks WHERE 1=1";
    const params: (string | number)[] = [];

    if (filters?.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.triggerType) {
      query += " AND trigger_type = ?";
      params.push(filters.triggerType);
    }

    query += " ORDER BY created_at DESC";

    if (filters?.limit) {
      query += " LIMIT ?";
      params.push(filters.limit);
    }
    if (filters?.offset) {
      query += " OFFSET ?";
      params.push(filters.offset);
    }

    const statement = this.database.prepare(query);
    return statement.all(...params) as TaskRow[];
  }

  updateTaskStatus(
    taskId: string,
    status: string,
    extra?: { output?: string; errorMessage?: string },
  ): void {
    let query = "UPDATE tasks SET status = ?";
    const params: string[] = [status];

    if (status === "running") {
      query += ", started_at = datetime('now')";
    }
    if (status === "completed" || status === "failed" || status === "cancelled") {
      query += ", completed_at = datetime('now')";
    }
    if (extra?.output !== undefined) {
      query += ", output = ?";
      params.push(extra.output);
    }
    if (extra?.errorMessage !== undefined) {
      query += ", error_message = ?";
      params.push(extra.errorMessage);
    }

    query += " WHERE id = ?";
    params.push(taskId);

    this.database.prepare(query).run(...params);
  }

  updateApprovalPolicy(taskId: string, approvalPolicy: string): void {
    this.database
      .prepare("UPDATE tasks SET approval_policy = ? WHERE id = ?")
      .run(approvalPolicy, taskId);
  }

  addTaskLog(
    taskId: string,
    level: string,
    message: string,
    metadata?: Record<string, string>,
  ): void {
    const statement = this.database.prepare(`
      INSERT INTO task_logs (task_id, level, message, metadata)
      VALUES (?, ?, ?, ?)
    `);
    statement.run(taskId, level, message, JSON.stringify(metadata ?? {}));
  }

  getTaskLogs(taskId: string): TaskLogRow[] {
    const statement = this.database.prepare(
      "SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at ASC",
    );
    return statement.all(taskId) as TaskLogRow[];
  }

  addEngineLog(level: string, source: string, message: string): void {
    this.database
      .prepare("INSERT INTO engine_logs (level, source, message) VALUES (?, ?, ?)")
      .run(level, source, message);
  }

  listRecentEngineLogs(limit: number = 200): EngineLogRow[] {
    return this.database
      .prepare("SELECT * FROM engine_logs ORDER BY id DESC LIMIT ?")
      .all(limit) as EngineLogRow[];
  }

  pruneEngineLogs(keepCount: number = 5000): void {
    this.database
      .prepare(
        "DELETE FROM engine_logs WHERE id NOT IN (SELECT id FROM engine_logs ORDER BY id DESC LIMIT ?)",
      )
      .run(keepCount);
  }

  listRecentLogs(limit: number = 100): TaskLogRow[] {
    const statement = this.database.prepare(
      "SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?",
    );
    return (statement.all(limit) as TaskLogRow[]).reverse();
  }

  getTaskCount(status?: string): number {
    let query = "SELECT COUNT(*) as count FROM tasks";
    const params: string[] = [];

    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }

    const result = this.database.prepare(query).get(...params) as { count: number };
    return result.count;
  }

  upsertThread(threadId: string, title: string, isActive: boolean): void {
    this.database
      .prepare(`
      INSERT INTO threads (id, title, is_active)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = ?, is_active = ?
    `)
      .run(threadId, title, isActive ? 1 : 0, title, isActive ? 1 : 0);
  }

  setActiveThread(threadId: string): void {
    this.database.exec("UPDATE threads SET is_active = 0");
    this.database.prepare("UPDATE threads SET is_active = 1 WHERE id = ?").run(threadId);
  }

  deleteThread(threadId: string): void {
    this.database.prepare("DELETE FROM thread_conversation WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM thread_messages WHERE thread_id = ?").run(threadId);
    this.database.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  }

  deleteAllThreads(): void {
    this.database.exec("DELETE FROM thread_conversation");
    this.database.exec("DELETE FROM thread_messages");
    this.database.exec("DELETE FROM threads");
  }

  listAllThreads(): ThreadRow[] {
    return this.database
      .prepare("SELECT * FROM threads ORDER BY created_at ASC")
      .all() as ThreadRow[];
  }

  replaceThreadMessages(threadId: string, messages: ThreadMessageRow[]): void {
    this.database.prepare("DELETE FROM thread_messages WHERE thread_id = ?").run(threadId);

    const statement = this.database.prepare(`
      INSERT INTO thread_messages (thread_id, role, content, raw_content, tool_name, tool_success, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const message of messages) {
      statement.run(
        threadId,
        message.role,
        message.content,
        message.raw_content ?? null,
        message.tool_name ?? null,
        message.tool_success ?? null,
        message.created_at,
      );
    }
  }

  getThreadMessages(threadId: string): ThreadMessageRow[] {
    return this.database
      .prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id ASC")
      .all(threadId) as ThreadMessageRow[];
  }

  replaceThreadConversation(threadId: string, messages: ThreadConversationRow[]): void {
    this.database.prepare("DELETE FROM thread_conversation WHERE thread_id = ?").run(threadId);

    const statement = this.database.prepare(`
      INSERT INTO thread_conversation (thread_id, role, content, position)
      VALUES (?, ?, ?, ?)
    `);

    for (const message of messages) {
      statement.run(threadId, message.role, message.content, message.position);
    }
  }

  getThreadConversation(threadId: string): ThreadConversationRow[] {
    return this.database
      .prepare("SELECT * FROM thread_conversation WHERE thread_id = ? ORDER BY position ASC")
      .all(threadId) as ThreadConversationRow[];
  }

  insertFact(category: string, content: string, source: string, tags: string[]): MemoryFactRow {
    const tagsValue = tags.join(",");

    this.database
      .prepare(`
      INSERT INTO memory_facts (category, content, source, tags)
      VALUES (?, ?, ?, ?)
    `)
      .run(category, content, source, tagsValue);

    const inserted = this.database
      .prepare("SELECT * FROM memory_facts WHERE id = last_insert_rowid()")
      .get() as MemoryFactRow;

    return inserted;
  }

  searchFacts(query: string, category?: string, limit: number = 10): MemoryFactRow[] {
    if (!query.trim()) {
      return this.listFactsByCategory(category, limit);
    }

    const terms = query
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `%${term}%`);

    if (terms.length === 0) {
      return this.listFactsByCategory(category, limit);
    }

    const termConditions = terms.map(() => "(content LIKE ? OR tags LIKE ?)").join(" OR ");

    let sql = `SELECT * FROM memory_facts WHERE (${termConditions})`;
    const params: (string | number)[] = terms.flatMap((term) => [term, term]);

    if (category) {
      sql += " AND category = ?";
      params.push(category);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);

    return this.database.prepare(sql).all(...params) as MemoryFactRow[];
  }

  listFactsByCategory(category?: string, limit: number = 20): MemoryFactRow[] {
    if (category) {
      return this.database
        .prepare("SELECT * FROM memory_facts WHERE category = ? ORDER BY updated_at DESC LIMIT ?")
        .all(category, limit) as MemoryFactRow[];
    }

    return this.database
      .prepare("SELECT * FROM memory_facts ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as MemoryFactRow[];
  }

  deleteFact(factId: number): boolean {
    const result = this.database.prepare("DELETE FROM memory_facts WHERE id = ?").run(factId);
    return result.changes > 0;
  }

  deleteFactsBySource(source: string): number {
    const result = this.database.prepare("DELETE FROM memory_facts WHERE source = ?").run(source);
    return result.changes;
  }

  updateFact(factId: number, content: string, tags: string[]): boolean {
    const tagsValue = tags.join(",");
    const result = this.database
      .prepare(`
      UPDATE memory_facts SET content = ?, tags = ?, updated_at = datetime('now') WHERE id = ?
    `)
      .run(content, tagsValue, factId);
    return result.changes > 0;
  }

  countFacts(category?: string): number {
    if (category) {
      const result = this.database
        .prepare("SELECT COUNT(*) as count FROM memory_facts WHERE category = ?")
        .get(category) as { count: number };
      return result.count;
    }

    const result = this.database.prepare("SELECT COUNT(*) as count FROM memory_facts").get() as {
      count: number;
    };
    return result.count;
  }

  appendThreadMessages(threadId: string, messages: ThreadMessageRow[]): void {
    if (messages.length === 0) return;

    const statement = this.database.prepare(`
      INSERT INTO thread_messages (thread_id, role, content, raw_content, tool_name, tool_success, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const message of messages) {
      statement.run(
        threadId,
        message.role,
        message.content,
        message.raw_content ?? null,
        message.tool_name ?? null,
        message.tool_success ?? null,
        message.created_at,
      );
    }
  }

  replaceThreadConversationFrom(
    threadId: string,
    fromPosition: number,
    messages: ThreadConversationRow[],
  ): void {
    this.database
      .prepare("DELETE FROM thread_conversation WHERE thread_id = ? AND position >= ?")
      .run(threadId, fromPosition);

    const statement = this.database.prepare(`
      INSERT INTO thread_conversation (thread_id, role, content, position)
      VALUES (?, ?, ?, ?)
    `);

    for (const message of messages) {
      statement.run(threadId, message.role, message.content, message.position);
    }
  }

  close(): void {
    this.database.close();
  }
}
