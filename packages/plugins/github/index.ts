import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";

const IS_WINDOWS = process.platform === "win32";

async function run(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = IS_WINDOWS ? ["cmd", "/c", ...args] : args;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function ghResult(r: { stdout: string; stderr: string; exitCode: number }): ToolResult {
  if (r.exitCode !== 0) {
    return { success: false, output: r.stderr || r.stdout || `gh exited with code ${r.exitCode}`, error: r.stderr };
  }
  return { success: true, output: r.stdout };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const ghIssueListTool: Tool = {
  definition: {
    name: "gh_issue_list",
    description: "List issues in the current GitHub repository. Returns a table of issues with number, title, labels, and state.",
    parameters: [
      { name: "labels", type: "string", description: "Comma-separated list of labels to filter by (e.g. 'bug,help wanted').", required: false },
      { name: "state", type: "string", description: "Filter by state: open, closed, or all. Default: open.", required: false },
      { name: "limit", type: "number", description: "Maximum number of issues to return. Default: 30.", required: false },
    ],
  },
  async execute(parameters, context) {
    const args = ["gh", "issue", "list"];
    if (parameters["labels"]) args.push("--label", String(parameters["labels"]));
    if (parameters["state"]) args.push("--state", String(parameters["state"]));
    args.push("--limit", String(parameters["limit"] ?? 30));
    return ghResult(await run(args, context.workingDirectory));
  },
};

const ghIssueCreateTool: Tool = {
  definition: {
    name: "gh_issue_create",
    description: "Create a new issue in the current GitHub repository.",
    parameters: [
      { name: "title", type: "string", description: "Issue title.", required: true },
      { name: "body", type: "string", description: "Issue body (supports Markdown).", required: true },
      { name: "labels", type: "string", description: "Comma-separated list of labels to apply.", required: false },
    ],
  },
  async execute(parameters, context) {
    const title = parameters["title"] as string;
    const body = parameters["body"] as string;
    if (!title || !body) return { success: false, output: "title and body parameters are required" };

    const args = ["gh", "issue", "create", "--title", title, "--body", body];
    if (parameters["labels"]) args.push("--label", String(parameters["labels"]));
    return ghResult(await run(args, context.workingDirectory));
  },
};

const ghIssueViewTool: Tool = {
  definition: {
    name: "gh_issue_view",
    description: "View details of a specific issue by number, including title, body, labels, assignees, and comments.",
    parameters: [
      { name: "number", type: "number", description: "Issue number.", required: true },
    ],
  },
  async execute(parameters, context) {
    const num = parameters["number"];
    if (num === undefined) return { success: false, output: "number parameter is required" };
    const args = ["gh", "issue", "view", String(num)];
    return ghResult(await run(args, context.workingDirectory));
  },
};

const ghPrListTool: Tool = {
  definition: {
    name: "gh_pr_list",
    description: "List pull requests in the current GitHub repository.",
    parameters: [
      { name: "state", type: "string", description: "Filter by state: open, closed, merged, or all. Default: open.", required: false },
      { name: "limit", type: "number", description: "Maximum number of PRs to return. Default: 30.", required: false },
    ],
  },
  async execute(parameters, context) {
    const args = ["gh", "pr", "list"];
    if (parameters["state"]) args.push("--state", String(parameters["state"]));
    args.push("--limit", String(parameters["limit"] ?? 30));
    return ghResult(await run(args, context.workingDirectory));
  },
};

const ghPrCreateTool: Tool = {
  definition: {
    name: "gh_pr_create",
    description: "Create a new pull request from the current or specified branch.",
    parameters: [
      { name: "title", type: "string", description: "PR title.", required: true },
      { name: "body", type: "string", description: "PR body/description (supports Markdown).", required: true },
      { name: "base", type: "string", description: "Base branch to merge into (e.g. 'main'). Default: repo default branch.", required: false },
      { name: "head", type: "string", description: "Head branch containing the changes. Default: current branch.", required: false },
      { name: "draft", type: "boolean", description: "Create as a draft PR. Default: false.", required: false },
    ],
  },
  async execute(parameters, context) {
    const title = parameters["title"] as string;
    const body = parameters["body"] as string;
    if (!title || !body) return { success: false, output: "title and body parameters are required" };

    const args = ["gh", "pr", "create", "--title", title, "--body", body];
    if (parameters["base"]) args.push("--base", String(parameters["base"]));
    if (parameters["head"]) args.push("--head", String(parameters["head"]));
    if (parameters["draft"] === true) args.push("--draft");
    return ghResult(await run(args, context.workingDirectory));
  },
};

const ghPrViewTool: Tool = {
  definition: {
    name: "gh_pr_view",
    description: "View details of a specific pull request by number, including title, body, review status, and CI checks.",
    parameters: [
      { name: "number", type: "number", description: "Pull request number.", required: true },
    ],
  },
  async execute(parameters, context) {
    const num = parameters["number"];
    if (num === undefined) return { success: false, output: "number parameter is required" };

    // Get PR details and checks status in one go
    const prResult = await run(["gh", "pr", "view", String(num)], context.workingDirectory);
    const checksResult = await run(["gh", "pr", "checks", String(num)], context.workingDirectory);

    const parts: string[] = [];
    if (prResult.exitCode === 0) {
      parts.push(prResult.stdout);
    } else {
      return ghResult(prResult);
    }
    if (checksResult.exitCode === 0 && checksResult.stdout) {
      parts.push("\n--- CI Checks ---\n" + checksResult.stdout);
    } else if (checksResult.stderr) {
      parts.push("\n--- CI Checks ---\nNo checks found or checks unavailable.");
    }

    return { success: true, output: parts.join("\n") };
  },
};

const ghPrMergeTool: Tool = {
  definition: {
    name: "gh_pr_merge",
    description: "Merge a pull request by number. The PR must be mergeable (approved, checks passing).",
    parameters: [
      { name: "number", type: "number", description: "Pull request number.", required: true },
      { name: "method", type: "string", description: "Merge method: merge, squash, or rebase. Default: merge.", required: false },
    ],
  },
  async execute(parameters, context) {
    const num = parameters["number"];
    if (num === undefined) return { success: false, output: "number parameter is required" };

    const method = String(parameters["method"] ?? "merge");
    if (!["merge", "squash", "rebase"].includes(method)) {
      return { success: false, output: `Invalid merge method '${method}'. Must be merge, squash, or rebase.` };
    }

    const args = ["gh", "pr", "merge", String(num), `--${method}`];
    return ghResult(await run(args, context.workingDirectory));
  },
};

const ghPrReviewTool: Tool = {
  definition: {
    name: "gh_pr_review",
    description: "Add a review to a pull request. Can approve, comment, or request changes.",
    parameters: [
      { name: "number", type: "number", description: "Pull request number.", required: true },
      { name: "body", type: "string", description: "Review comment body.", required: true },
      { name: "event", type: "string", description: "Review event: approve, comment, or request-changes. Default: comment.", required: false },
    ],
  },
  async execute(parameters, context) {
    const num = parameters["number"];
    const body = parameters["body"] as string;
    if (num === undefined || !body) return { success: false, output: "number and body parameters are required" };

    const event = String(parameters["event"] ?? "comment");
    const eventMap: Record<string, string> = {
      approve: "--approve",
      comment: "--comment",
      "request-changes": "--request-changes",
    };
    const flag = eventMap[event];
    if (!flag) {
      return { success: false, output: `Invalid event '${event}'. Must be approve, comment, or request-changes.` };
    }

    const args = ["gh", "pr", "review", String(num), flag, "--body", body];
    return ghResult(await run(args, context.workingDirectory));
  },
};

const ghRepoViewTool: Tool = {
  definition: {
    name: "gh_repo_view",
    description: "View information about the current GitHub repository including description, visibility, default branch, and stats.",
    parameters: [],
  },
  async execute(_parameters, context) {
    return ghResult(await run(["gh", "repo", "view"], context.workingDirectory));
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default definePlugin({
  name: "github",
  version: "0.1.0",
  description: "GitHub integration via the gh CLI. Manage issues, pull requests, and repository info.",
  author: "kraken",

  toolDisplayNames: {
    gh_issue_list: "List Issues",
    gh_issue_create: "Create Issue",
    gh_issue_view: "View Issue",
    gh_pr_list: "List PRs",
    gh_pr_create: "Create PR",
    gh_pr_view: "View PR",
    gh_pr_merge: "Merge PR",
    gh_pr_review: "Review PR",
    gh_repo_view: "Repo Info",
  },

  tools: [
    ghIssueListTool,
    ghIssueCreateTool,
    ghIssueViewTool,
    ghPrListTool,
    ghPrCreateTool,
    ghPrViewTool,
    ghPrMergeTool,
    ghPrReviewTool,
    ghRepoViewTool,
  ],

  promptExtension:
    "You have GitHub tools from the 'github' plugin powered by the gh CLI. " +
    "Available tools: gh_issue_list, gh_issue_create, gh_issue_view, gh_pr_list, gh_pr_create, gh_pr_view, gh_pr_merge, gh_pr_review, gh_repo_view.\n" +
    "REQUIREMENT: The GitHub CLI (gh) must be installed and authenticated. " +
    "If gh commands fail with auth errors, the user needs to run 'gh auth login' in their terminal first.\n" +
    "All commands run against the repository in the current working directory. " +
    "Use gh_repo_view to confirm which repo you are operating on before making changes.\n" +
    "When creating PRs or issues, use Markdown formatting in the body for best results.",

  activate: async () => {
    try {
      const result = await run(["gh", "auth", "status"]);
      if (result.exitCode !== 0) {
        console.log("[github] WARNING: gh CLI is not authenticated. Run 'gh auth login' to authenticate.");
      } else {
        console.log("[github] activated (gh CLI authenticated)");
      }
    } catch {
      console.log("[github] WARNING: gh CLI is not installed. Install it from https://cli.github.com/");
    }
  },
});
