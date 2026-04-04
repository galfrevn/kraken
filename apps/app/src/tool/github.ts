import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { getDaemon } from "@/daemon/client.ts";

export const githubPrListTool = defineTool({
  id: "github_pr_list",
  description:
    "List pull requests on a GitHub repository. Returns open PRs by default. Use when the user asks about PRs, reviews, or open changes.",
  parameters: z.object({
    repo: z
      .string()
      .optional()
      .describe("Repository in 'owner/repo' format. Uses default repo if omitted."),
    state: z.string().optional().describe("PR state: 'open' (default), 'closed', or 'all'"),
  }),
  async execute(args) {
    try {
      const params = new URLSearchParams();
      if (args.repo) params.set("repo", args.repo);
      if (args.state) params.set("state", args.state);
      const result = await getDaemon().request<{
        pulls: Array<{
          number: number;
          title: string;
          user: { login: string };
          state: string;
          created_at: string;
          draft: boolean;
        }>;
      }>("GET", `/api/github/pulls?${params}`);
      if (result.pulls.length === 0)
        return { title: "No PRs found", content: "No pull requests match the query." };
      const lines = result.pulls.map(
        (pr) =>
          `#${pr.number} ${pr.title} (by ${pr.user?.login ?? "unknown"})${pr.draft ? " [draft]" : ""}`,
      );
      return { title: `${result.pulls.length} PR(s)`, content: lines.join("\n") };
    } catch (error) {
      return { title: "GitHub error", content: String(error) };
    }
  },
});

export const githubPrGetTool = defineTool({
  id: "github_pr_get",
  description:
    "Get details of a specific pull request including title, body, changed files count, and status.",
  parameters: z.object({
    number: z.number().describe("PR number"),
    repo: z.string().optional().describe("Repository in 'owner/repo' format"),
  }),
  async execute(args) {
    try {
      const params = args.repo ? `?repo=${args.repo}` : "";
      const pr = await getDaemon().request<{
        number: number;
        title: string;
        body: string;
        state: string;
        user: { login: string };
        changed_files: number;
        additions: number;
        deletions: number;
        head: { ref: string };
        base: { ref: string };
        mergeable: boolean;
      }>("GET", `/api/github/pulls/${args.number}${params}`);
      return {
        title: `PR #${pr.number}: ${pr.title}`,
        content: [
          `Author: ${pr.user?.login}`,
          `Branch: ${pr.head?.ref} → ${pr.base?.ref}`,
          `Status: ${pr.state}`,
          `Changes: +${pr.additions} -${pr.deletions} (${pr.changed_files} files)`,
          `Mergeable: ${pr.mergeable ?? "unknown"}`,
          pr.body ? `\nDescription:\n${pr.body}` : "",
        ].join("\n"),
      };
    } catch (error) {
      return { title: "GitHub error", content: String(error) };
    }
  },
});

export const githubPrCreateTool = defineTool({
  id: "github_pr_create",
  description: "Create a new pull request on GitHub. Use after pushing changes to a branch.",
  parameters: z.object({
    title: z.string().describe("PR title"),
    body: z.string().optional().describe("PR description (markdown)"),
    head: z.string().describe("Source branch name"),
    base: z.string().optional().describe("Target branch (default: 'main')"),
    repo: z.string().optional().describe("Repository in 'owner/repo' format"),
  }),
  async execute(args) {
    try {
      const result = await getDaemon().request<{ number: number; html_url: string }>(
        "POST",
        "/api/github/pulls",
        { title: args.title, body: args.body, head: args.head, base: args.base, repo: args.repo },
      );
      return { title: `PR #${result.number} created`, content: result.html_url };
    } catch (error) {
      return { title: "Failed to create PR", content: String(error) };
    }
  },
});

export const githubPrCommentTool = defineTool({
  id: "github_pr_comment",
  description: "Post a comment on a pull request or issue.",
  parameters: z.object({
    number: z.number().describe("PR or issue number"),
    body: z.string().describe("Comment text (markdown)"),
    repo: z.string().optional().describe("Repository in 'owner/repo' format"),
  }),
  async execute(args) {
    try {
      await getDaemon().request("POST", `/api/github/pulls/${args.number}/comments`, {
        body: args.body,
        repo: args.repo,
      });
      return { title: "Comment posted", content: `Comment added to #${args.number}` };
    } catch (error) {
      return { title: "Failed to comment", content: String(error) };
    }
  },
});

export const githubPrMergeTool = defineTool({
  id: "github_pr_merge",
  description: "Merge a pull request.",
  parameters: z.object({
    number: z.number().describe("PR number to merge"),
    repo: z.string().optional().describe("Repository in 'owner/repo' format"),
  }),
  async execute(args) {
    try {
      const params = args.repo ? `?repo=${args.repo}` : "";
      await getDaemon().request("POST", `/api/github/pulls/${args.number}/merge${params}`, {});
      return { title: "PR merged", content: `PR #${args.number} has been merged.` };
    } catch (error) {
      return { title: "Failed to merge", content: String(error) };
    }
  },
});

export const githubIssueListTool = defineTool({
  id: "github_issue_list",
  description: "List issues on a GitHub repository.",
  parameters: z.object({
    repo: z.string().optional().describe("Repository in 'owner/repo' format"),
    state: z.string().optional().describe("Issue state: 'open' (default), 'closed', or 'all'"),
  }),
  async execute(args) {
    try {
      const params = new URLSearchParams();
      if (args.repo) params.set("repo", args.repo);
      if (args.state) params.set("state", args.state);
      const result = await getDaemon().request<{
        issues: Array<{
          number: number;
          title: string;
          user: { login: string };
          labels: Array<{ name: string }>;
        }>;
      }>("GET", `/api/github/issues?${params}`);
      // Filter out PRs (GitHub API returns PRs as issues)
      const issues = result.issues.filter((i: Record<string, unknown>) => !i.pull_request);
      if (issues.length === 0) return { title: "No issues", content: "No issues match the query." };
      const lines = issues.map((issue) => {
        const labels = issue.labels?.map((l) => l.name).join(", ");
        return `#${issue.number} ${issue.title}${labels ? ` [${labels}]` : ""}`;
      });
      return { title: `${issues.length} issue(s)`, content: lines.join("\n") };
    } catch (error) {
      return { title: "GitHub error", content: String(error) };
    }
  },
});

export const githubIssueCreateTool = defineTool({
  id: "github_issue_create",
  description: "Create a new issue on GitHub.",
  parameters: z.object({
    title: z.string().describe("Issue title"),
    body: z.string().optional().describe("Issue body (markdown)"),
    repo: z.string().optional().describe("Repository in 'owner/repo' format"),
  }),
  async execute(args) {
    try {
      const result = await getDaemon().request<{ number: number; html_url: string }>(
        "POST",
        "/api/github/issues",
        { title: args.title, body: args.body, repo: args.repo },
      );
      return { title: `Issue #${result.number} created`, content: result.html_url };
    } catch (error) {
      return { title: "Failed to create issue", content: String(error) };
    }
  },
});
