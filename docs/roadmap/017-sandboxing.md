# Command Sandboxing

## Summary

Execute agent bash commands in a restricted environment that limits filesystem access, network access, and system calls. Prevent prompt injection or agent errors from causing destructive actions (`rm -rf /`, exfiltrating secrets, installing malware).

## Motivation

The `bash` tool currently runs commands with the full permissions of the user running Kraken. A malicious prompt injection, a confused agent, or a badly-written skill could:
- Delete files outside the repo
- Read and exfiltrate API keys or SSH keys
- Install packages with malicious post-install scripts
- Modify system configuration
- Send data to external servers

The existing `security.ts` blocks some secret-reading patterns, but it's a blocklist (bypassable) rather than an allowlist.

## Current State

- `apps/app/src/tool/bash.ts`: `Bun.spawn` with the user's full shell, no restrictions.
- `apps/app/src/tool/security.ts`: blocklist-based — blocks commands combining file-read tools with secret-like paths. Pattern matching, easily bypassed with obfuscation.
- No filesystem or network restrictions.

## Architecture

### Tiered Sandbox Levels

```typescript
type SandboxLevel = "none" | "basic" | "strict" | "container";
```

#### Level 0: None (current behavior)
No restrictions. For trusted environments.

#### Level 1: Basic (recommended default)
- Block destructive commands (`rm -rf /`, `mkfs`, `dd`, `:(){ :|:& };:`)
- Restrict filesystem writes to repo directory only
- Block access to `~/.ssh`, `~/.gnupg`, `~/.aws`, system dirs
- Allow network access (needed for `npm install`, `git`, etc.)

#### Level 2: Strict
- Everything from Level 1
- Block network access except to localhost and configured allowlist
- Read-only access outside repo directory
- Block `sudo`, `su`, privilege escalation
- Limit process spawn count
- Limit execution time (already has 120s timeout)

#### Level 3: Container (most secure)
- Run each command in a disposable container (Docker/Podman)
- Mount repo directory as the only writable volume
- No network by default, explicit allowlist
- Resource limits (CPU, memory, disk)
- Automatic cleanup after command completes

### Implementation: Level 1 & 2 (macOS/Linux)

#### Filesystem Restrictions

```typescript
// tool/sandbox.ts
const BLOCKED_PATHS = [
  "/etc", "/usr", "/bin", "/sbin", "/var",
  "~/.ssh", "~/.gnupg", "~/.aws", "~/.config",
  "~/.kraken/.env", "~/.kraken/secrets",
];

const BLOCKED_COMMANDS = [
  /\brm\s+(-[rf]+\s+)?\/(?!.*\bnode_modules\b)/,  // rm -rf / (but allow rm in repo)
  /\bmkfs\b/, /\bdd\b.*\bof=\/dev/, /\bformat\b/,
  /\bsudo\b/, /\bsu\b/, /\bchmod\s+[0-7]*777/,
  /\bcurl\b.*\|\s*(bash|sh|zsh)/,                  // curl | bash piping
  /\bwget\b.*\|\s*(bash|sh|zsh)/,
];

export function validateCommand(command: string, level: SandboxLevel, repoPath: string): ValidationResult {
  if (level === "none") return { allowed: true };

  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `Blocked pattern: ${pattern.source}` };
    }
  }

  // Check for path access outside repo
  const accessedPaths = extractPathsFromCommand(command);
  for (const path of accessedPaths) {
    const resolved = resolvePath(path);
    if (!resolved.startsWith(repoPath) && !isAllowedSystemPath(resolved)) {
      return { allowed: false, reason: `Access outside repo: ${resolved}` };
    }
  }

  return { allowed: true };
}
```

#### Process-Level Restrictions (macOS: sandbox-exec, Linux: seccomp/landlock)

```typescript
// On macOS, use sandbox-exec with a profile
function buildSandboxProfile(repoPath: string, level: SandboxLevel): string {
  return `
    (version 1)
    (deny default)
    (allow file-read* (subpath "${repoPath}"))
    (allow file-write* (subpath "${repoPath}"))
    (allow file-read* (subpath "/usr/lib"))
    (allow file-read* (subpath "/usr/bin"))
    (allow process-exec)
    (allow process-fork)
    ${level === "basic" ? "(allow network*)" : "(allow network* (local ip \"localhost:*\"))"}
  `;
}

// Wrap command execution
async function executeInSandbox(command: string, options: SandboxOptions): Promise<SpawnResult> {
  if (process.platform === "darwin") {
    return Bun.spawn(["sandbox-exec", "-p", buildSandboxProfile(options.repoPath, options.level), "sh", "-c", command]);
  }
  // Linux: use bubblewrap (bwrap) or firejail
  if (process.platform === "linux") {
    return Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--bind", options.repoPath, options.repoPath, "--unshare-net", "--", "sh", "-c", command]);
  }
}
```

### Implementation: Level 3 (Container)

```typescript
async function executeInContainer(command: string, options: ContainerOptions): Promise<SpawnResult> {
  const containerCmd = [
    "docker", "run", "--rm",
    "--network", options.allowNetwork ? "bridge" : "none",
    "--memory", options.maxMemory ?? "512m",
    "--cpus", options.maxCpus ?? "1",
    "-v", `${options.repoPath}:/workspace`,
    "-w", "/workspace",
    options.image ?? "node:20-slim",
    "sh", "-c", command,
  ];

  return Bun.spawn(containerCmd, { timeout: options.timeoutMs });
}
```

### Command Allowlist (Alternative Approach)

Instead of blocking dangerous commands, only allow known-safe commands:

```typescript
const ALLOWED_COMMANDS = [
  "node", "npm", "npx", "bun", "bunx",
  "cargo", "rustc", "rustfmt", "clippy",
  "git", "gh",
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "grep", "rg", "find",
  "echo", "printf", "test", "mkdir", "cp", "mv", "touch",
  "python", "pip", "python3",
  "go", "make", "cmake",
  "docker", "docker-compose",
  "curl", "wget",  // allowed in basic, blocked in strict
];
```

### Agent Feedback

When a command is blocked, provide a helpful message:

```typescript
if (!validation.allowed) {
  return {
    title: "Command blocked by sandbox",
    content: `The command was blocked: ${validation.reason}\n\nSandbox level: ${level}\nTo adjust, modify sandbox.level in kraken.jsonc.\n\nIf this command is necessary, consider:\n- Running it manually outside Kraken\n- Adding it to the sandbox allowlist\n- Lowering the sandbox level (not recommended)`,
  };
}
```

## Configuration

```jsonc
{
  "sandbox": {
    "level": "basic",                    // "none" | "basic" | "strict" | "container"
    "allowedPaths": [],                  // additional paths the agent can access
    "blockedPaths": [],                  // additional paths to block
    "allowedCommands": [],               // additional commands to allow
    "blockedCommands": [],               // additional commands to block
    "networkAllowlist": ["localhost"],    // allowed network targets (strict mode)
    "containerImage": "node:20-slim",    // for container mode
    "maxMemory": "512m",                 // for container mode
    "maxCpus": "1"                       // for container mode
  }
}
```

## Dependencies on Other Roadmap Items

- **Audit log** (016): All sandbox violations should be audit-logged.
- **Rate limiting** (018): Sandbox and rate limiting work together for safety.
