export type CommandRiskLevel = "safe" | "moderate" | "dangerous" | "blocked";

export interface CommandPolicyResult {
  allowed: boolean;
  riskLevel: CommandRiskLevel;
  reason?: string;
}

export interface CommandPolicyConfiguration {
  allowedPrefixes: string[];
  blockedPrefixes: string[];
  allowUnknown: boolean;
  requireConfirmationAbove: CommandRiskLevel;
}

const HARD_BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!tmp)/,
    reason: "recursive delete on root or system paths",
  },
  {
    pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?!tmp)/,
    reason: "recursive delete on root or system paths",
  },
  { pattern: /mkfs\./, reason: "filesystem formatting" },
  { pattern: /dd\s+.*of=\/dev\//, reason: "raw disk write" },
  { pattern: /:\(\)\{.*:\|:.*\};:/, reason: "fork bomb" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "raw disk overwrite" },
  { pattern: /chmod\s+-R\s+777\s+\//, reason: "recursive permission change on root" },
  { pattern: /chown\s+-R\s+.*\s+\/(?!tmp)/, reason: "recursive ownership change on root" },
  { pattern: /shutdown/, reason: "system shutdown" },
  { pattern: /reboot/, reason: "system reboot" },
  { pattern: /init\s+[06]/, reason: "system halt/reboot" },
  {
    pattern: /systemctl\s+(stop|disable|mask)\s+(sshd|networking|firewalld|iptables)/,
    reason: "disabling critical services",
  },
  { pattern: /iptables\s+-F/, reason: "flushing firewall rules" },
  { pattern: /curl\s+.*\|\s*(bash|sh|zsh)/, reason: "piping remote script to shell" },
  { pattern: /wget\s+.*\|\s*(bash|sh|zsh)/, reason: "piping remote script to shell" },
  { pattern: /eval\s+.*\$\(curl/, reason: "evaluating remote content" },
  { pattern: /passwd/, reason: "password modification" },
  { pattern: /useradd|userdel|usermod/, reason: "user account modification" },
  { pattern: /visudo|sudoers/, reason: "sudo configuration" },
  { pattern: /crontab\s+-r/, reason: "removing all crontab entries" },
  { pattern: />\s*\/etc\//, reason: "overwriting system configuration" },
  { pattern: /rm\s+.*\/etc\//, reason: "deleting system configuration" },
  { pattern: /DROP\s+(DATABASE|TABLE)/i, reason: "destructive SQL operation" },
  { pattern: /TRUNCATE\s+TABLE/i, reason: "destructive SQL operation" },
];

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /sudo\s/, reason: "elevated privileges" },
  { pattern: /su\s+-/, reason: "switching user" },
  { pattern: /rm\s+-[a-zA-Z]*r/, reason: "recursive delete" },
  { pattern: /rm\s+-[a-zA-Z]*f/, reason: "force delete" },
  { pattern: /git\s+push\s+.*--force/, reason: "force push" },
  { pattern: /git\s+reset\s+--hard/, reason: "hard reset" },
  { pattern: /git\s+clean\s+-[a-zA-Z]*f/, reason: "force clean" },
  { pattern: /npm\s+publish/, reason: "publishing package" },
  { pattern: /docker\s+rm/, reason: "removing containers" },
  { pattern: /docker\s+system\s+prune/, reason: "pruning docker system" },
  { pattern: /kubectl\s+delete/, reason: "deleting kubernetes resources" },
  { pattern: />\s+[^\s]+/, reason: "file overwrite via redirect" },
  { pattern: /pip\s+install\s+(?!-r)(?!--requirement)/, reason: "installing python packages" },
  { pattern: /npm\s+install\s+-g/, reason: "global npm install" },
];

const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /npm\s+(install|uninstall|update)/, reason: "modifying npm dependencies" },
  { pattern: /yarn\s+(add|remove|upgrade)/, reason: "modifying yarn dependencies" },
  { pattern: /bun\s+(add|remove|update)/, reason: "modifying bun dependencies" },
  { pattern: /pip\s+install\s+-r/, reason: "installing from requirements" },
  { pattern: /git\s+(checkout|branch|merge|rebase|stash)/, reason: "git branch operation" },
  { pattern: /docker\s+(build|run|compose)/, reason: "docker operation" },
  { pattern: /mv\s/, reason: "moving/renaming files" },
  { pattern: /cp\s+-r/, reason: "recursive copy" },
  { pattern: /chmod\s/, reason: "permission change" },
  { pattern: /chown\s/, reason: "ownership change" },
];

const SAFE_PREFIXES: string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "echo",
  "pwd",
  "whoami",
  "date",
  "wc",
  "sort",
  "uniq",
  "grep",
  "rg",
  "find",
  "which",
  "where",
  "type",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch -a",
  "git remote -v",
  "git stash list",
  "node -v",
  "npm -v",
  "bun -v",
  "python --version",
  "go version",
  "rustc --version",
  "cargo --version",
  "tree",
  "du -sh",
  "df -h",
  "uname",
  "env",
  "printenv",
  "npm list",
  "npm outdated",
  "npm run",
  "npm test",
  "npm start",
  "bun run",
  "bun test",
  "yarn run",
  "yarn test",
  "cargo check",
  "cargo test",
  "cargo build",
  "cargo clippy",
  "go build",
  "go test",
  "go vet",
  "go fmt",
  "tsc",
  "eslint",
  "prettier",
  "jest",
  "vitest",
  "mocha",
  "make",
  "cmake",
];

function getBaseCommand(command: string): string {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  return parts[0] ?? "";
}

function matchesAnyPattern(
  command: string,
  patterns: Array<{ pattern: RegExp; reason: string }>,
): string | undefined {
  for (const entry of patterns) {
    if (entry.pattern.test(command)) {
      return entry.reason;
    }
  }
  return undefined;
}

function matchesPrefix(command: string, prefixes: string[]): boolean {
  const normalized = command.trim().toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

export function classifyCommand(command: string): { riskLevel: CommandRiskLevel; reason?: string } {
  const blockedReason = matchesAnyPattern(command, HARD_BLOCKED_PATTERNS);
  if (blockedReason) {
    return { riskLevel: "blocked", reason: blockedReason };
  }

  const dangerousReason = matchesAnyPattern(command, DANGEROUS_PATTERNS);
  if (dangerousReason) {
    return { riskLevel: "dangerous", reason: dangerousReason };
  }

  const moderateReason = matchesAnyPattern(command, MODERATE_PATTERNS);
  if (moderateReason) {
    return { riskLevel: "moderate", reason: moderateReason };
  }

  if (matchesPrefix(command, SAFE_PREFIXES)) {
    return { riskLevel: "safe" };
  }

  return { riskLevel: "moderate", reason: "unrecognized command" };
}

export function evaluateCommandPolicy(
  command: string,
  configuration?: CommandPolicyConfiguration,
): CommandPolicyResult {
  const classification = classifyCommand(command);

  if (classification.riskLevel === "blocked") {
    return {
      allowed: false,
      riskLevel: "blocked",
      reason: `blocked: ${classification.reason}`,
    };
  }

  if (configuration) {
    if (configuration.blockedPrefixes.length > 0) {
      if (matchesPrefix(command, configuration.blockedPrefixes)) {
        return {
          allowed: false,
          riskLevel: "blocked",
          reason: "blocked by configuration",
        };
      }
    }

    if (configuration.allowedPrefixes.length > 0) {
      if (!matchesPrefix(command, configuration.allowedPrefixes)) {
        if (!configuration.allowUnknown) {
          return {
            allowed: false,
            riskLevel: classification.riskLevel,
            reason: "not in allowed commands list",
          };
        }
      }
    }
  }

  return {
    allowed: true,
    riskLevel: classification.riskLevel,
    reason: classification.reason,
  };
}

export function formatPolicyDenial(result: CommandPolicyResult, command: string): string {
  const baseCommand = getBaseCommand(command);
  return (
    `command denied: ${baseCommand}\n` +
    `  risk: ${result.riskLevel}\n` +
    `  reason: ${result.reason ?? "policy restriction"}\n` +
    `  hint: use a safer alternative or ask the user to run this command manually`
  );
}

export const DEFAULT_COMMAND_POLICY: CommandPolicyConfiguration = {
  allowedPrefixes: [],
  blockedPrefixes: [],
  allowUnknown: true,
  requireConfirmationAbove: "dangerous",
};
