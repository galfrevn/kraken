import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { getDaemon } from "@/daemon/client.ts";
import { generateEmbedding, encodeEmbeddingToBase64 } from "@/provider/embedding.ts";
import { DaemonError, DaemonConnectionError } from "@kraken/sdk";

export const memorySearchTool = defineTool({
  id: "memory_search",
  description:
    "Search persistent memory or get a specific observation by ID. Returns full content. Use when the user references past work, preferences, or anything previously discussed.",
  parameters: z.object({
    query: z.string().optional().describe("Keywords to search for in memory"),
    id: z.number().optional().describe("Get a specific observation by its numeric ID"),
    type: z.string().optional().describe("Filter by type (optional)"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  }),
  async execute(args, _context) {
    try {
      if (args.id !== undefined) {
        return await getObservationById(args.id);
      }

      if (!args.query) {
        return {
          title: "Missing parameter",
          content: "Provide either 'query' to search or 'id' to get a specific observation.",
        };
      }

      let queryEmbedding: number[] | null = null;
      try {
        queryEmbedding = await generateEmbedding(args.query);
      } catch {
        // embedding is optional
      }

      const results = await getDaemon().memory.search({
        q: args.query,
        type: args.type,
        limit: args.limit,
        embedding: queryEmbedding ? encodeEmbeddingToBase64(queryEmbedding) : undefined,
      });

      if (results.length === 0) {
        return {
          title: "No memories found",
          content: `No observations matching "${args.query}" found in memory.`,
        };
      }

      const formatted = results
        .map((result) => {
          const revisionNote = result.revision_count > 1 ? ` (rev ${result.revision_count})` : "";
          return `[#${result.id}] [${result.type}] ${result.title}${revisionNote}\n${result.content}`;
        })
        .join("\n\n---\n\n");

      return {
        title: `Found ${results.length} memories`,
        content: formatted,
        metadata: { resultCount: results.length },
      };
    } catch (error) {
      if (error instanceof DaemonError) {
        return {
          title: "Memory search failed",
          content: `Daemon returned ${error.status}: ${error.body}`,
        };
      }
      if (error instanceof DaemonConnectionError) {
        return {
          title: "Memory search failed",
          content: `Could not reach daemon at ${error.url}. Is it running?`,
        };
      }
      return {
        title: "Memory search failed",
        content: `Unexpected error: ${error}`,
      };
    }
  },
});

async function getObservationById(observationId: number) {
  try {
    const observation = await getDaemon().memory.observations.get(observationId);
    const revisionNote =
      observation.revision_count > 1 ? ` (revision ${observation.revision_count})` : "";
    const topicNote = observation.topic_key ? `\nTopic: ${observation.topic_key}` : "";

    return {
      title: `Memory #${observation.id}: ${observation.title}`,
      content: `[${observation.type}] ${observation.title}${revisionNote}${topicNote}\nScope: ${observation.scope} | Project: ${observation.project ?? "none"}\n\n${observation.content}`,
      metadata: { observationId: observation.id },
    };
  } catch (error) {
    if (error instanceof DaemonError && error.status === 404) {
      return {
        title: "Memory not found",
        content: `No observation with ID #${observationId} exists.`,
      };
    }
    throw error;
  }
}
