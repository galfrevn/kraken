import { $ } from "bun";
import { cpus, totalmem, freemem, hostname, homedir } from "node:os";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export const environmentTool: Tool = {
  definition: {
    name: "environment",
    description:
      "Get information about the current system environment: OS, architecture, runtime versions, " +
      "git user, available memory, disk space, and working directory. " +
      "Useful for understanding the development environment and debugging platform-specific issues.",
    parameters: [],
  },

  async execute(
    _parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const sections: string[] = [];

    sections.push("## system");
    sections.push(`  os: ${process.platform} ${process.arch}`);
    sections.push(`  hostname: ${hostname()}`);
    sections.push(`  cpus: ${cpus().length} × ${cpus()[0]?.model ?? "unknown"}`);
    sections.push(`  memory: ${formatBytes(freemem())} free / ${formatBytes(totalmem())} total`);
    sections.push(`  home: ${homedir()}`);
    sections.push(`  cwd: ${context.workingDirectory}`);

    sections.push("\n## runtime");
    sections.push(`  bun: ${Bun.version}`);

    const nodeVersion = await safeCommand("node -v");
    if (nodeVersion) sections.push(`  node: ${nodeVersion}`);

    const npmVersion = await safeCommand("npm -v");
    if (npmVersion) sections.push(`  npm: ${npmVersion}`);

    sections.push("\n## languages");
    const runtimeChecks = [
      { name: "go", command: "go version" },
      { name: "rust", command: "rustc --version" },
      { name: "python", command: "python3 --version" },
      { name: "ruby", command: "ruby --version" },
      { name: "java", command: "java --version 2>&1 | head -1" },
    ];

    for (const check of runtimeChecks) {
      const version = await safeCommand(check.command);
      if (version) {
        sections.push(`  ${check.name}: ${version.split("\n")[0]}`);
      }
    }

    sections.push("\n## git");
    const gitUser = await safeCommand("git config user.name");
    const gitEmail = await safeCommand("git config user.email");
    const gitBranch = await safeCommand("git branch --show-current");

    if (gitUser) sections.push(`  user: ${gitUser}`);
    if (gitEmail) sections.push(`  email: ${gitEmail}`);
    if (gitBranch) sections.push(`  branch: ${gitBranch}`);

    sections.push("\n## environment variables");
    const relevantVars = ["SHELL", "EDITOR", "TERM", "LANG", "PATH"];
    for (const varName of relevantVars) {
      const value = process.env[varName];
      if (value) {
        const displayValue =
          varName === "PATH" ? value.split(":").slice(0, 5).join(":") + " ..." : value;
        sections.push(`  ${varName}: ${displayValue}`);
      }
    }

    return { success: true, output: sections.join("\n") };
  },
};

async function safeCommand(command: string): Promise<string | null> {
  try {
    const result = await $`sh -c ${command}`.quiet().nothrow();
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    return output || null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
