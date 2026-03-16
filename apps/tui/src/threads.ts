import { LanguageModelClient } from "@core/language/client.ts";
import { ToolRegistry } from "@core/tools/registry.ts";
import { AgentDatabase } from "@core/storage/database.ts";
import type { ThreadMessageRow, ThreadConversationRow } from "@core/storage/database.ts";
import { ChatEngine, type SerializedChatEngine } from "@/engine.ts";
import type { MemoryContext, PromptOptions, EnvironmentContext } from "@core/agent/prompt.ts";

const SAVE_DEBOUNCE_MILLISECONDS = 1500;

export interface ThreadSummary {
  identifier: string;
  title: string;
  messageCount: number;
  createdAt: Date;
  active: boolean;
  isProcessing: boolean;
}

const UNTITLED_THREAD_PREFIX = "new conversation";
const TITLE_GENERATION_MODEL = "openrouter/free";
const TITLE_GENERATION_SYSTEM_PROMPT =
  "You are a title generator. Given a user message, output a short label (3-6 words) that captures the TOPIC, not the answer. " +
  "Never include data, prices, numbers, results, or conclusions — only the subject. " +
  "Examples: 'precio elden ring ps5', 'refactor auth middleware', 'deploy staging fix'. " +
  "Reply ONLY with the title. No quotes, no punctuation, no explanation. " +
  "Lowercase. Same language as the user.";

const SUMMARY_GENERATION_SYSTEM_PROMPT =
  "You are a session summarizer. Given a conversation between a user and a developer agent, " +
  "produce a concise summary (3-6 sentences) capturing:\n" +
  "1. What the user asked for\n" +
  "2. What was done (files modified, decisions made, tools used)\n" +
  "3. Key outcomes or unresolved items\n\n" +
  "Reply ONLY with the summary text. No headers, no bullet points, no labels. " +
  "Write in past tense. Be specific about file names and technical decisions. " +
  "Always write the summary in English regardless of the conversation language.";

const MINIMUM_MESSAGES_FOR_SUMMARY = 2;
const MAXIMUM_TRANSCRIPT_LENGTH = 5000;

let threadCounter = 0;

function generateThreadIdentifier(): string {
  threadCounter += 1;
  return `thread-${threadCounter}`;
}

function generateDefaultTitle(): string {
  return UNTITLED_THREAD_PREFIX;
}

export type ThreadChangeListener = () => void;

export class ThreadManager {
  private threads: Map<string, ChatEngine> = new Map();
  private threadMetadata: Map<string, { title: string; createdAt: Date }> = new Map();
  private activeThreadIdentifier: string = "";
  private languageModelClient: LanguageModelClient;
  private toolRegistry: ToolRegistry;
  private workingDirectory: string;
  private database: AgentDatabase;
  private changeListeners: Set<ThreadChangeListener> = new Set();
  private savedMessageCounts: Map<string, number> = new Map();
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private logPersister?: (level: string, source: string, message: string) => void;

  constructor(
    languageModelClient: LanguageModelClient,
    toolRegistry: ToolRegistry,
    workingDirectory: string,
    database: AgentDatabase,
  ) {
    this.languageModelClient = languageModelClient;
    this.toolRegistry = toolRegistry;
    this.workingDirectory = workingDirectory;
    this.database = database;
  }

  setLogPersister(persister: (level: string, source: string, message: string) => void): void {
    this.logPersister = persister;
  }

  initialize(): void {
    const loaded = this.loadFromDatabase();
    if (!loaded) {
      const firstThread = this.createThread();
      this.activeThreadIdentifier = firstThread;
    }
  }

  private loadMemoryContext(): MemoryContext | undefined {
    try {
      const facts = this.database.listFactsByCategory(undefined, 50);
      const conversationFacts = facts.filter((fact) => fact.source === "conversation");
      if (conversationFacts.length === 0) return undefined;

      return {
        facts: conversationFacts.map((fact) => ({
          id: fact.id,
          category: fact.category,
          content: fact.content,
          tags: fact.tags,
        })),
      };
    } catch {
      return undefined;
    }
  }

  private buildEnvironmentContext(): EnvironmentContext {
    return {
      workingDirectory: this.workingDirectory,
      platform: process.platform,
      shell: process.env.SHELL || (process.platform === "win32" ? "powershell" : "bash"),
      date: new Date().toISOString().split("T")[0]!,
      modelName: this.languageModelClient.getModel(),
      projectName: this.workingDirectory.split(/[/\\]/).pop() || "unknown",
    };
  }

  private buildPromptOptions(): PromptOptions {
    return {
      memoryContext: this.loadMemoryContext(),
      environmentContext: this.buildEnvironmentContext(),
    };
  }

  getLanguageModelClient(): LanguageModelClient {
    return this.languageModelClient;
  }

  isActiveThreadEmpty(): boolean {
    const engine = this.threads.get(this.activeThreadIdentifier);
    if (!engine) return true;
    return engine.getMessages().length === 0;
  }

  createThread(title?: string): string {
    const identifier = generateThreadIdentifier();
    const displayTitle = title ?? generateDefaultTitle();

    const engine = new ChatEngine(
      this.languageModelClient,
      this.toolRegistry,
      this.workingDirectory,
      this.buildPromptOptions(),
    );

    if (this.logPersister) {
      engine.setLogPersister(this.logPersister);
    }

    engine.addEventListener(() => {
      if (!engine.isProcessing()) {
        this.scheduleSave();
      }
    });

    this.threads.set(identifier, engine);
    this.threadMetadata.set(identifier, {
      title: displayTitle,
      createdAt: new Date(),
    });

    this.scheduleSave();
    return identifier;
  }

  switchThread(identifier: string): boolean {
    if (!this.threads.has(identifier)) return false;

    const previousIdentifier = this.activeThreadIdentifier;
    this.activeThreadIdentifier = identifier;
    this.emitChange();
    this.scheduleSave();

    if (previousIdentifier && previousIdentifier !== identifier) {
      this.summarizeThread(previousIdentifier).catch(() => {});
    }

    return true;
  }

  switchThreadByIndex(index: number): boolean {
    const identifiers = Array.from(this.threads.keys());
    if (index < 0 || index >= identifiers.length) return false;
    const identifier = identifiers[index];
    if (!identifier) return false;
    this.activeThreadIdentifier = identifier;
    this.emitChange();
    this.scheduleSave();
    return true;
  }

  getActiveEngine(): ChatEngine {
    const engine = this.threads.get(this.activeThreadIdentifier);
    if (!engine) {
      throw new Error("active thread not found");
    }
    return engine;
  }

  getActiveThreadIdentifier(): string {
    return this.activeThreadIdentifier;
  }

  getActiveThreadTitle(): string {
    return this.threadMetadata.get(this.activeThreadIdentifier)?.title ?? "untitled";
  }

  setThreadTitle(identifier: string, title: string): void {
    const metadata = this.threadMetadata.get(identifier);
    if (metadata) {
      metadata.title = title;
      this.emitChange();
      this.scheduleSave();
    }
  }

  async generateActiveThreadTitle(): Promise<void> {
    const engine = this.getActiveEngine();
    const messages = engine.getMessages();
    const metadata = this.threadMetadata.get(this.activeThreadIdentifier);

    if (!metadata) return;

    const isUntitled = metadata.title === UNTITLED_THREAD_PREFIX;
    if (!isUntitled) return;

    const userMessages = messages.filter((message) => message.role === "user");
    const hasAssistantResponse = messages.some(
      (message) => message.role === "assistant" && message.content.trim().length > 0,
    );
    if (userMessages.length === 0 || !hasAssistantResponse) return;

    const substantiveMessage =
      userMessages.find((message) => message.content.trim().length > 10) ?? userMessages[0]!;
    const titleInput = substantiveMessage.content.slice(0, 300);

    const truncatedFallback =
      substantiveMessage.content.length > 40
        ? substantiveMessage.content.slice(0, 40) + "..."
        : substantiveMessage.content;

    try {
      const generatedTitle = await this.languageModelClient.singlePrompt(
        titleInput,
        TITLE_GENERATION_SYSTEM_PROMPT,
        {
          model: TITLE_GENERATION_MODEL,
          temperature: 0.3,
          maxTokens: 24,
        },
      );

      const cleanedTitle = generatedTitle
        .replace(/^["']|["']$/g, "")
        .replace(/\.+$/, "")
        .trim()
        .toLowerCase();

      metadata.title = cleanedTitle || truncatedFallback;
    } catch {
      metadata.title = truncatedFallback;
    }

    this.emitChange();
    this.scheduleSave();
  }

  async summarizeThread(identifier: string): Promise<void> {
    const engine = this.threads.get(identifier);
    const metadata = this.threadMetadata.get(identifier);
    if (!engine || !metadata) return;

    const messages = engine.getMessages();
    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.length < MINIMUM_MESSAGES_FOR_SUMMARY) return;

    const existingSummaries = this.database.searchFacts(identifier, "context", 1);
    const alreadySummarized = existingSummaries.some(
      (fact) => fact.source === "summary" && fact.tags.includes(identifier),
    );
    if (alreadySummarized) return;

    const transcript = this.buildCondensedTranscript(messages);

    try {
      const generatedSummary = await this.languageModelClient.singlePrompt(
        transcript,
        SUMMARY_GENERATION_SYSTEM_PROMPT,
        {
          model: TITLE_GENERATION_MODEL,
          temperature: 0.3,
          maxTokens: 256,
        },
      );

      const cleanedSummary = generatedSummary.replace(/^["']|["']$/g, "").trim();

      if (cleanedSummary.length < 20) return;

      const title = metadata.title !== UNTITLED_THREAD_PREFIX ? metadata.title : "untitled session";

      const tags = [identifier, "session"];

      const toolNames = [
        ...new Set(
          messages.filter((message) => message.role === "tool_call" && message.toolName).map((message) => message.toolName!),
        ),
      ];
      if (toolNames.length > 0) {
        tags.push(...toolNames.slice(0, 5));
      }

      this.database.insertFact("context", `Session "${title}": ${cleanedSummary}`, "summary", tags);
    } catch {
      // non-critical, continue silently
    }
  }

  private buildCondensedTranscript(messages: Array<{ role: string; content: string }>): string {
    const relevantMessages = messages.filter((message) => message.role === "user" || message.role === "assistant");

    const lines: string[] = [];
    let totalLength = 0;

    for (const message of relevantMessages) {
      const role = message.role === "user" ? "User" : "Agent";
      const content =
        message.content.length > 400 ? message.content.slice(0, 400) + "..." : message.content;

      const line = `${role}: ${content}`;

      if (totalLength + line.length > MAXIMUM_TRANSCRIPT_LENGTH) break;

      lines.push(line);
      totalLength += line.length;
    }

    return lines.join("\n\n");
  }

  deleteThread(identifier: string): boolean {
    if (identifier === this.activeThreadIdentifier) {
      if (this.threads.size <= 1) return false;

      const identifiers = Array.from(this.threads.keys());
      const currentIndex = identifiers.indexOf(identifier);
      const nextIdentifier = identifiers[currentIndex === 0 ? 1 : currentIndex - 1];
      if (nextIdentifier) {
        this.activeThreadIdentifier = nextIdentifier;
      }
    }

    this.summarizeThread(identifier).catch(() => {});

    const engine = this.threads.get(identifier);
    if (engine) {
      engine.removeAllListeners();
    }

    this.savedMessageCounts.delete(identifier);
    this.threads.delete(identifier);
    this.threadMetadata.delete(identifier);

    try {
      this.database.deleteThread(identifier);
    } catch {
      // continue
    }

    this.emitChange();
    this.scheduleSave();
    return true;
  }

  listThreads(): ThreadSummary[] {
    const summaries: ThreadSummary[] = [];

    for (const [identifier, engine] of this.threads) {
      const metadata = this.threadMetadata.get(identifier);
      const messages = engine.getMessages();
      const conversationCount = messages.filter(
        (message) => message.role === "user" || message.role === "assistant",
      ).length;

      summaries.push({
        identifier,
        title: metadata?.title ?? "untitled",
        messageCount: conversationCount,
        createdAt: metadata?.createdAt ?? new Date(),
        active: identifier === this.activeThreadIdentifier,
        isProcessing: engine.isProcessing(),
      });
    }

    return summaries;
  }

  getThreadCount(): number {
    return this.threads.size;
  }

  purgeAllThreads(): string {
    for (const engine of this.threads.values()) {
      engine.removeAllListeners();
    }

    this.threads.clear();
    this.threadMetadata.clear();
    this.savedMessageCounts.clear();

    try {
      this.database.deleteAllThreads();
    } catch {
      // continue
    }

    const freshIdentifier = this.createThread();
    this.activeThreadIdentifier = freshIdentifier;

    this.emitChange();
    this.saveNow();

    return freshIdentifier;
  }

  onThreadChange(listener: ThreadChangeListener): void {
    this.changeListeners.add(listener);
  }

  offThreadChange(listener: ThreadChangeListener): void {
    this.changeListeners.delete(listener);
  }

  saveNow(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.saveToDatabase();

    if (this.activeThreadIdentifier) {
      this.summarizeThread(this.activeThreadIdentifier).catch(() => {});
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveToDatabase();
      this.saveTimeout = null;
    }, SAVE_DEBOUNCE_MILLISECONDS);
  }

  private saveToDatabase(): void {
    try {
      for (const [identifier, engine] of this.threads) {
        const metadata = this.threadMetadata.get(identifier);
        if (!metadata) continue;

        const isActive = identifier === this.activeThreadIdentifier;
        this.database.upsertThread(identifier, metadata.title, isActive);

        const state = engine.exportState();

        const savedCount = this.savedMessageCounts.get(identifier) ?? 0;

        const messageRows: ThreadMessageRow[] = state.messages.map((message) => ({
          role: message.role,
          content: message.content,
          raw_content:
            message.rawContent ??
            (message.attachments ? JSON.stringify(message.attachments) : null),
          tool_name: message.toolName ?? null,
          tool_success: message.toolSuccess !== undefined ? (message.toolSuccess ? 1 : 0) : null,
          created_at: message.timestamp,
        }));

        if (savedCount === 0) {
          this.database.replaceThreadMessages(identifier, messageRows);
        } else {
          const newMessages = messageRows.slice(savedCount);
          if (newMessages.length > 0) {
            this.database.appendThreadMessages(identifier, newMessages);
          }
        }
        this.savedMessageCounts.set(identifier, messageRows.length);

        const conversationRows: ThreadConversationRow[] = state.conversationMessages.map(
          (message, index) => ({
            role: message.role,
            content: message.content,
            position: index,
          }),
        );

        this.database.replaceThreadConversation(identifier, conversationRows);
      }
    } catch (saveError) {
      console.error("[threads] failed to save to database:", saveError);
    }
  }

  private loadFromDatabase(): boolean {
    try {
      const threadRows = this.database.listAllThreads();
      if (threadRows.length === 0) return false;

      let maxCounter = 0;

      for (const row of threadRows) {
        const numberMatch = row.id.match(/^thread-(\d+)$/);
        if (numberMatch) {
          const number = parseInt(numberMatch[1] ?? "0", 10);
          if (number > maxCounter) maxCounter = number;
        }

        const engine = new ChatEngine(
          this.languageModelClient,
          this.toolRegistry,
          this.workingDirectory,
          this.buildPromptOptions(),
        );

        if (this.logPersister) {
          engine.setLogPersister(this.logPersister);
        }

        const messageRows = this.database.getThreadMessages(row.id);
        const conversationRows = this.database.getThreadConversation(row.id);

        const serializedState: SerializedChatEngine = {
          messages: messageRows.map((messageRow) => {
            let rawContent = messageRow.raw_content ?? undefined;
            let attachments: import("@/engine.ts").FileAttachment[] | undefined;
            if (messageRow.role === "user" && rawContent) {
              try {
                const parsed = JSON.parse(rawContent);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].path) {
                  attachments = parsed;
                  rawContent = undefined;
                }
              } catch {
                /* not JSON, keep as rawContent */
              }
            }
            return {
              role: messageRow.role as any,
              content: messageRow.content,
              rawContent,
              timestamp: messageRow.created_at,
              toolName: messageRow.tool_name ?? undefined,
              toolSuccess:
                messageRow.tool_success !== null ? messageRow.tool_success === 1 : undefined,
              attachments,
            };
          }),
          conversationMessages: conversationRows
            .map((conversationRow) => ({
              role: conversationRow.role,
              content: conversationRow.content,
            })),
        };

        engine.importState(serializedState);

        engine.addEventListener(() => {
          if (!engine.isProcessing()) {
            this.scheduleSave();
          }
        });

        this.threads.set(row.id, engine);
        this.threadMetadata.set(row.id, {
          title: row.title,
          createdAt: new Date(row.created_at),
        });

        if (row.is_active) {
          this.activeThreadIdentifier = row.id;
        }
      }

      threadCounter = maxCounter;

      if (!this.activeThreadIdentifier) {
        const firstIdentifier = this.threads.keys().next().value;
        if (firstIdentifier) {
          this.activeThreadIdentifier = firstIdentifier as string;
        } else {
          return false;
        }
      }

      return true;
    } catch (loadError) {
      console.error("[threads] failed to load from database:", loadError);
      return false;
    }
  }
}
