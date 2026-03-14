/**
 * Cross-platform command spawning that avoids Bun's `$` shell escaping.
 *
 * Bun's `$\`cmd /c ${command}\`` escapes the interpolated value, which breaks
 * pipes, quoted arguments, and other shell constructs on Windows. Using
 * `Bun.spawn` directly bypasses this and lets the target shell (cmd or sh)
 * interpret the command string as-is.
 */

const IS_WINDOWS = process.platform === "win32";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a program with explicit args (no shell involved).
 * Preferred for tools like `rg`, `git` where we control the argument list.
 */
export async function spawnCommand(
  program: string,
  args: string[],
  cwd: string,
): Promise<SpawnResult> {
  const proc = Bun.spawn([program, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

/**
 * Run an arbitrary command string through the platform shell.
 * Used for user-provided commands where pipes/redirects must be interpreted.
 */
export async function spawnShellCommand(
  command: string,
  cwd: string,
): Promise<SpawnResult> {
  const shellArgs = IS_WINDOWS ? ["cmd", "/c", command] : ["sh", "-c", command];

  const proc = Bun.spawn(shellArgs, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}
