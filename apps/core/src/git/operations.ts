import { $ } from "bun";
import type { GitConfiguration } from "@/configuration/schema.ts";

export interface GitFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
}

export interface GitDiffResult {
  raw: string;
  files: string[];
  insertions: number;
  deletions: number;
}

export class GitOperations {
  private repositoryPath: string;
  private branchPrefix: string;
  private commitPrefix: string;
  private autoCommit: boolean;

  constructor(repositoryPath: string, gitConfiguration: GitConfiguration) {
    this.repositoryPath = repositoryPath;
    this.branchPrefix = gitConfiguration.branchPrefix;
    this.commitPrefix = gitConfiguration.commitPrefix;
    this.autoCommit = gitConfiguration.autoCommit;
  }

  async isRepository(): Promise<boolean> {
    try {
      await this.executeGitCommand("rev-parse", "--is-inside-work-tree");
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch(): Promise<string> {
    return this.executeGitCommand("rev-parse", "--abbrev-ref", "HEAD");
  }

  async createBranch(name: string): Promise<string> {
    const fullBranchName = `${this.branchPrefix}${name}`;
    await this.executeGitCommand("checkout", "-b", fullBranchName);
    return fullBranchName;
  }

  async checkoutBranch(branchName: string): Promise<void> {
    await this.executeGitCommand("checkout", branchName);
  }

  async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.executeGitCommand("rev-parse", "--verify", branchName);
      return true;
    } catch {
      return false;
    }
  }

  async listChangedFiles(): Promise<GitFileChange[]> {
    const statusOutput = await this.executeGitCommand("status", "--porcelain");
    if (!statusOutput.trim()) return [];

    return statusOutput
      .trim()
      .split("\n")
      .map((line) => {
        const statusCode = line.substring(0, 2).trim();
        const filePath = line.substring(3);
        return {
          path: filePath,
          status: this.parseStatusCode(statusCode),
        };
      });
  }

  async diff(staged: boolean = false): Promise<GitDiffResult> {
    const diffArguments = staged ? ["diff", "--cached", "--stat"] : ["diff", "--stat"];
    const statOutput = await this.executeGitCommand(...diffArguments);

    const rawDiffArguments = staged ? ["diff", "--cached"] : ["diff"];
    const rawOutput = await this.executeGitCommand(...rawDiffArguments);

    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;

    for (const line of statOutput.split("\n")) {
      const fileMatch = line.match(/^\s*(.+?)\s*\|/);
      if (fileMatch?.[1]) {
        files.push(fileMatch[1].trim());
      }
      const summaryMatch = line.match(/(\d+) insertions?\(\+\)/);
      const deletionMatch = line.match(/(\d+) deletions?\(-\)/);
      if (summaryMatch?.[1]) insertions = parseInt(summaryMatch[1], 10);
      if (deletionMatch?.[1]) deletions = parseInt(deletionMatch[1], 10);
    }

    return { raw: rawOutput, files, insertions, deletions };
  }

  async stageAll(): Promise<void> {
    await this.executeGitCommand("add", "-A");
  }

  async stageFiles(filePaths: string[]): Promise<void> {
    await this.executeGitCommand("add", ...filePaths);
  }

  async commit(message: string): Promise<string> {
    const fullMessage = `${this.commitPrefix} ${message}`;
    if (this.autoCommit) {
      await this.stageAll();
    }
    const output = await this.executeGitCommand("commit", "-m", fullMessage);
    const hashMatch = output.match(/\[.+\s([a-f0-9]+)\]/);
    return hashMatch?.[1] ?? "";
  }

  async push(remote: string = "origin", branchName?: string): Promise<void> {
    const currentBranch = branchName ?? (await this.getCurrentBranch());
    await this.executeGitCommand("push", remote, currentBranch);
  }

  async pushWithUpstream(remote: string = "origin", branchName?: string): Promise<void> {
    const currentBranch = branchName ?? (await this.getCurrentBranch());
    await this.executeGitCommand("push", "-u", remote, currentBranch);
  }

  async readFile(filePath: string): Promise<string> {
    const absolutePath = `${this.repositoryPath}/${filePath}`;
    return Bun.file(absolutePath).text();
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absolutePath = `${this.repositoryPath}/${filePath}`;
    await Bun.write(absolutePath, content);
  }

  async log(count: number = 10): Promise<string> {
    return this.executeGitCommand("log", `--oneline`, `-${count}`);
  }

  private parseStatusCode(code: string): GitFileChange["status"] {
    switch (code) {
      case "A":
        return "added";
      case "M":
        return "modified";
      case "D":
        return "deleted";
      case "R":
        return "renamed";
      case "??":
        return "untracked";
      default:
        return "modified";
    }
  }

  private async executeGitCommand(...commandArguments: string[]): Promise<string> {
    const result = await $`git -C ${this.repositoryPath} ${commandArguments}`.quiet();
    return result.text().trim();
  }
}
