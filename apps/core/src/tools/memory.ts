import type { AgentDatabase } from "@/storage/database.ts";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";
import { ProjectIndexer } from "@/memory/indexer.ts";

const VALID_CATEGORIES = [
  "architecture",
  "convention",
  "preference",
  "dependency",
  "pattern",
  "decision",
  "context",
] as const;

type FactCategory = (typeof VALID_CATEGORIES)[number];

function isValidCategory(value: string): value is FactCategory {
  return VALID_CATEGORIES.includes(value as FactCategory);
}

function parseTags(rawTags: string | undefined): string[] {
  if (!rawTags) return [];
  return rawTags
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

export function createRememberTool(database: AgentDatabase): Tool {
  return {
    definition: {
      name: "remember",
      description: "Store a fact in persistent memory. Persists across sessions.",
      parameters: [
        {
          name: "category",
          type: "string" as const,
          description:
            "Category for the fact: architecture, convention, preference, dependency, pattern, decision, or context.",
          required: true,
        },
        {
          name: "content",
          type: "string" as const,
          description:
            "The fact to remember. Be specific and self-contained so it is useful without extra context. " +
            "Example: 'The project uses Drizzle ORM with PostgreSQL for the main database.'",
          required: true,
        },
        {
          name: "tags",
          type: "string" as const,
          description: "Comma-separated tags for searchability (e.g. 'database,orm,drizzle').",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const category = (parameters["category"] as string).toLowerCase();
      const content = parameters["content"] as string;
      const tags = parseTags(parameters["tags"] as string | undefined);

      if (!isValidCategory(category)) {
        return {
          success: false,
          output: "",
          error: `invalid category "${category}". Valid categories: ${VALID_CATEGORIES.join(", ")}`,
        };
      }

      if (!content || content.trim().length < 10) {
        return {
          success: false,
          output: "",
          error: "content must be at least 10 characters and self-contained.",
        };
      }

      const existingFacts = database.searchFacts(content, category, 3);
      const duplicate = existingFacts.find(
        (fact) => fact.content.toLowerCase() === content.toLowerCase(),
      );

      if (duplicate) {
        if (tags.length > 0) {
          const existingTags = duplicate.tags ? duplicate.tags.split(",") : [];
          const mergedTags = [...new Set([...existingTags, ...tags])];
          database.updateFact(duplicate.id, content, mergedTags);
          return {
            success: true,
            output: `updated existing fact #${duplicate.id} with new tags.`,
          };
        }

        return {
          success: true,
          output: `fact already exists (id: ${duplicate.id}). No changes made.`,
        };
      }

      const inserted = database.insertFact(category, content.trim(), "conversation", tags);

      return {
        success: true,
        output: `remembered fact #${inserted.id} [${category}]${tags.length > 0 ? ` (tags: ${tags.join(", ")})` : ""}`,
      };
    },
  };
}

export function createRecallTool(database: AgentDatabase): Tool {
  return {
    definition: {
      name: "recall",
      description: "Search persistent memory for stored facts.",
      parameters: [
        {
          name: "query",
          type: "string" as const,
          description:
            "Search terms to find relevant facts (e.g. 'database', 'testing convention', 'auth pattern').",
          required: false,
        },
        {
          name: "category",
          type: "string" as const,
          description:
            "Filter by category: architecture, convention, preference, dependency, pattern, decision, or context.",
          required: false,
        },
        {
          name: "limit",
          type: "number" as const,
          description: "Maximum number of facts to return (default: 10).",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const query = (parameters["query"] as string | undefined) ?? "";
      const category = parameters["category"] as string | undefined;
      const limit = (parameters["limit"] as number | undefined) ?? 10;

      if (category && !isValidCategory(category.toLowerCase())) {
        return {
          success: false,
          output: "",
          error: `invalid category "${category}". Valid categories: ${VALID_CATEGORIES.join(", ")}`,
        };
      }

      const normalizedCategory = category?.toLowerCase();
      const totalFacts = database.countFacts(normalizedCategory);

      if (totalFacts === 0) {
        const scope = normalizedCategory ? `in category "${normalizedCategory}"` : "in memory";
        return {
          success: true,
          output: `no facts stored ${scope}. Use the remember tool to store facts during conversations.`,
        };
      }

      const facts = query.trim()
        ? database.searchFacts(query, normalizedCategory, limit)
        : database.listFactsByCategory(normalizedCategory, limit);

      if (facts.length === 0) {
        return {
          success: true,
          output: `no facts matching "${query}"${normalizedCategory ? ` in category "${normalizedCategory}"` : ""}. ${totalFacts} total facts in memory.`,
        };
      }

      const formattedFacts = facts.map((fact) => {
        const tagsLabel = fact.tags ? ` [${fact.tags}]` : "";
        return `#${fact.id} (${fact.category})${tagsLabel}: ${fact.content}`;
      });

      const header = query.trim()
        ? `${facts.length} facts matching "${query}"${normalizedCategory ? ` in ${normalizedCategory}` : ""} (${totalFacts} total):`
        : `${facts.length} facts${normalizedCategory ? ` in ${normalizedCategory}` : ""} (${totalFacts} total):`;

      return {
        success: true,
        output: header + "\n" + formattedFacts.join("\n"),
      };
    },
  };
}

export function createIndexProjectTool(database: AgentDatabase): Tool {
  return {
    definition: {
      name: "index_project",
      description: "Scan project structure and store in persistent memory.",
      parameters: [],
    },

    async execute(
      _parameters: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const indexer = new ProjectIndexer(database);

      try {
        const result = await indexer.indexProject(context.workingDirectory);

        return {
          success: true,
          output:
            `project indexed: ${result.factsCreated} facts stored from ${result.filesScanned} files ` +
            `(${result.duration}ms). Use recall to search project knowledge.`,
        };
      } catch (indexError) {
        const errorMessage = indexError instanceof Error ? indexError.message : String(indexError);

        return {
          success: false,
          output: "",
          error: `indexing failed: ${errorMessage}`,
        };
      }
    },
  };
}
