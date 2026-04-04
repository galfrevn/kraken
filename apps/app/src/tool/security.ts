import { basename } from "node:path";

const BLOCKED_FILE_PATTERNS = [".env", "credentials", "secrets"];

const BLOCKED_BASH_READ_COMMANDS = [
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "view",
  "nano",
  "vim",
  "vi",
  "code",
  "open",
  "xdg-open",
  "type",
  "Get-Content",
  "gc",
  "strings",
  "xxd",
  "hexdump",
  "od",
  "base64",
  "cp",
  "mv",
  "curl",
  "wget",
];

export function isBlockedFilePath(filePath: string): boolean {
  const fileName = basename(filePath).toLowerCase();
  return BLOCKED_FILE_PATTERNS.some(
    (pattern) => fileName === pattern || fileName.endsWith(pattern),
  );
}

export function bashCommandTargetsSecretFile(command: string): boolean {
  const normalizedCommand = command.toLowerCase();

  if (
    normalizedCommand.includes("localhost") ||
    normalizedCommand.includes("127.0.0.1") ||
    normalizedCommand.includes("http://") ||
    normalizedCommand.includes("https://")
  ) {
    return false;
  }

  const referencesSecretFile = BLOCKED_FILE_PATTERNS.some(
    (pattern) =>
      normalizedCommand.includes(`/${pattern}`) ||
      normalizedCommand.includes(` ${pattern}`) ||
      normalizedCommand.startsWith(pattern),
  );

  if (!referencesSecretFile) return false;

  return BLOCKED_BASH_READ_COMMANDS.some((readCommand) =>
    normalizedCommand.includes(readCommand.toLowerCase()),
  );
}

export const BLOCKED_FILE_ACCESS_MESSAGE =
  "Access denied: this file may contain secrets. Use the daemon API to manage secrets (load the 'secrets' skill for instructions).";
