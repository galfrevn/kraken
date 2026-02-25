import { $ } from "bun";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const GIT_TIMEOUT_MILLISECONDS = 15_000;

async function runGitCommand(
  args: string,
  workingDirectory: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const commandPromise = $`sh -c ${"git " + args}`.cwd(workingDirectory).quiet().nothrow();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("git command timed out")), GIT_TIMEOUT_MILLISECONDS),
  );

  const result = await Promise.race([commandPromise, timeoutPromise]);

  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

export const gitStatusTool: Tool = {
  definition: {
    name: "git_status",
    description:
      "Show the current git repository status: branch name, staged/unstaged changes, untracked files. " +
      "Use this before committing to see what has changed.",
    parameters: [],
  },

  async execute(
    _parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      const branchResult = await runGitCommand("branch --show-current", context.workingDirectory);
      const statusResult = await runGitCommand("status --short", context.workingDirectory);

      if (statusResult.exitCode !== 0) {
        return { success: false, output: "", error: statusResult.stderr || "not a git repository" };
      }

      const branch = branchResult.stdout || "(detached HEAD)";
      const changes = statusResult.stdout || "(no changes)";

      return { success: true, output: `branch: ${branch}\n\n${changes}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: message };
    }
  },
};

export const gitDiffTool: Tool = {
  definition: {
    name: "git_diff",
    description:
      "Show git diff of changes. By default shows unstaged changes. " +
      "Use staged=true to see staged changes. Optionally filter by file path.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Specific file or directory to diff (default: all files)",
        required: false,
      },
      {
        name: "staged",
        type: "boolean",
        description: "Show staged changes instead of unstaged (default: false)",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = parameters["path"] as string | undefined;
    const staged = parameters["staged"] === true || parameters["staged"] === "true";

    let command = "diff --stat --patch";
    if (staged) command += " --cached";
    if (filePath) command += ` -- ${filePath}`;

    try {
      const result = await runGitCommand(command, context.workingDirectory);

      if (result.exitCode !== 0) {
        return { success: false, output: "", error: result.stderr || "git diff failed" };
      }

      const output = result.stdout || "(no changes)";
      const lines = output.split("\n");

      if (lines.length > 300) {
        return {
          success: true,
          output:
            lines.slice(0, 300).join("\n") + `\n\n... truncated (${lines.length - 300} more lines)`,
        };
      }

      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: message };
    }
  },
};

export const gitCommitTool: Tool = {
  definition: {
    name: "git_commit",
    description:
      "Stage files and create a git commit. If no files are specified, stages all changes. " +
      "Always run git_status first to review changes before committing.",
    parameters: [
      { name: "message", type: "string", description: "Commit message", required: true },
      {
        name: "files",
        type: "string",
        description: "Space-separated list of files to stage (default: all changes with '.')",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const message = parameters["message"] as string;
    const files = (parameters["files"] as string) || ".";

    if (!message) {
      return { success: false, output: "", error: "commit message is required" };
    }

    try {
      const addResult = await runGitCommand(`add ${files}`, context.workingDirectory);
      if (addResult.exitCode !== 0) {
        return { success: false, output: "", error: `git add failed: ${addResult.stderr}` };
      }

      const escapedMessage = message.replace(/'/g, "'\\''");
      const commitResult = await runGitCommand(
        `commit -m '${escapedMessage}'`,
        context.workingDirectory,
      );

      if (commitResult.exitCode !== 0) {
        return { success: false, output: "", error: commitResult.stderr || "git commit failed" };
      }

      return { success: true, output: commitResult.stdout };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: errorMessage };
    }
  },
};

export const gitLogTool: Tool = {
  definition: {
    name: "git_log",
    description: "Show recent git commit history. Returns commit hash, author, date, and message.",
    parameters: [
      {
        name: "count",
        type: "number",
        description: "Number of commits to show (default: 10, max: 50)",
        required: false,
      },
      {
        name: "path",
        type: "string",
        description: "Show commits affecting a specific file or directory",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const count = Math.min(Math.max(Number(parameters["count"]) || 10, 1), 50);
    const filePath = parameters["path"] as string | undefined;

    let command = `log --oneline --decorate -n ${count}`;
    if (filePath) command += ` -- ${filePath}`;

    try {
      const result = await runGitCommand(command, context.workingDirectory);

      if (result.exitCode !== 0) {
        return { success: false, output: "", error: result.stderr || "git log failed" };
      }

      return { success: true, output: result.stdout || "(no commits)" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: message };
    }
  },
};
