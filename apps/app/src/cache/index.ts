import { statSync } from "node:fs";
import { createHash } from "node:crypto";

const MAX_FILE_CACHE_ENTRIES = 500;
const MAX_FILE_CACHE_BYTES = 50_000_000;
const MAX_RESULT_CACHE_ENTRIES = 200;
const RESULT_CACHE_TTL_MS = 300_000;

interface CachedFile {
  content: string;
  mtimeMs: number;
  size: number;
  lastAccess: number;
}

interface CachedToolResult {
  result: { title: string; content: string; metadata?: Record<string, unknown> };
  dependentPaths: string[];
  cachedAt: number;
  ttlMs: number;
}

class FileCache {
  private entries = new Map<string, CachedFile>();
  private totalBytes = 0;
  hits = 0;
  misses = 0;

  get(path: string): string | null {
    const entry = this.entries.get(path);
    if (!entry) {
      this.misses++;
      return null;
    }

    try {
      const stat = statSync(path);
      if (stat.mtimeMs !== entry.mtimeMs) {
        this.remove(path);
        this.misses++;
        return null;
      }
    } catch {
      this.remove(path);
      this.misses++;
      return null;
    }

    entry.lastAccess = Date.now();
    this.hits++;
    return entry.content;
  }

  set(path: string, content: string, mtimeMs: number): void {
    this.remove(path);

    while (
      this.totalBytes + content.length > MAX_FILE_CACHE_BYTES ||
      this.entries.size >= MAX_FILE_CACHE_ENTRIES
    ) {
      if (!this.evictLru()) break;
    }

    this.entries.set(path, {
      content,
      mtimeMs,
      size: content.length,
      lastAccess: Date.now(),
    });
    this.totalBytes += content.length;
  }

  invalidate(path: string): void {
    this.remove(path);
  }

  invalidateByPrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.remove(key);
      }
    }
  }

  private remove(path: string): void {
    const entry = this.entries.get(path);
    if (entry) {
      this.totalBytes -= entry.size;
      this.entries.delete(path);
    }
  }

  private evictLru(): boolean {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.remove(oldestKey);
      return true;
    }
    return false;
  }
}

function hashArgs(args: unknown): string {
  const serialized = JSON.stringify(args, Object.keys(args as Record<string, unknown>).sort());
  return createHash("md5").update(serialized).digest("hex");
}

class ToolResultCache {
  private entries = new Map<string, CachedToolResult>();
  hits = 0;
  misses = 0;

  get(
    toolId: string,
    args: unknown,
  ): { title: string; content: string; metadata?: Record<string, unknown> } | null {
    const key = `${toolId}:${hashArgs(args)}`;
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.entries.delete(key);
      this.misses++;
      return null;
    }

    for (const depPath of entry.dependentPaths) {
      try {
        const stat = statSync(depPath);
        if (stat.mtimeMs > entry.cachedAt) {
          this.entries.delete(key);
          this.misses++;
          return null;
        }
      } catch {
        this.entries.delete(key);
        this.misses++;
        return null;
      }
    }

    this.hits++;
    return entry.result;
  }

  set(
    toolId: string,
    args: unknown,
    result: { title: string; content: string; metadata?: Record<string, unknown> },
    dependentPaths: string[],
    ttlMs: number = RESULT_CACHE_TTL_MS,
  ): void {
    const key = `${toolId}:${hashArgs(args)}`;

    while (this.entries.size >= MAX_RESULT_CACHE_ENTRIES) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey) this.entries.delete(firstKey);
      else break;
    }

    this.entries.set(key, {
      result,
      dependentPaths,
      cachedAt: Date.now(),
      ttlMs,
    });
  }

  invalidateByPath(path: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.dependentPaths.some((dep) => path.startsWith(dep) || dep.startsWith(path))) {
        this.entries.delete(key);
      }
    }
  }
}

export const fileCache = new FileCache();
export const toolResultCache = new ToolResultCache();
