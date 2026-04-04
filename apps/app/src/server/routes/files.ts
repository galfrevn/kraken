import { Hono } from "hono";
import { Glob } from "bun";
import { basename } from "node:path";
import fuzzysort from "fuzzysort";

export const filesRouter = new Hono();

const MAX_FILE_SEARCH_RESULTS = 15;
const MAX_FILE_SCAN_COUNT = 5000;
const FILE_INDEX_TTL_MILLISECONDS = 30_000;

const IGNORED_DIRECTORIES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  ".turbo",
  ".cache",
  "coverage",
];

interface FileIndexEntry {
  path: string;
  name: string;
}

let cachedFileIndex: FileIndexEntry[] | null = null;
let fileIndexTimestamp = 0;
let fileIndexBuildPromise: Promise<FileIndexEntry[]> | null = null;

function shouldIgnorePath(filePath: string): boolean {
  return IGNORED_DIRECTORIES.some(
    (ignored) => filePath.includes(`/${ignored}/`) || filePath.startsWith(`${ignored}/`),
  );
}

async function buildFileIndex(): Promise<FileIndexEntry[]> {
  const workingDirectory = process.cwd();
  const globInstance = new Glob("**/*");
  const entries: FileIndexEntry[] = [];

  for await (const matchedPath of globInstance.scan({ cwd: workingDirectory, dot: false })) {
    if (shouldIgnorePath(matchedPath)) continue;
    entries.push({ path: matchedPath, name: basename(matchedPath) });
    if (entries.length >= MAX_FILE_SCAN_COUNT) break;
  }

  return entries;
}

async function getFileIndex(): Promise<FileIndexEntry[]> {
  const now = Date.now();

  if (cachedFileIndex && now - fileIndexTimestamp < FILE_INDEX_TTL_MILLISECONDS) {
    return cachedFileIndex;
  }

  if (fileIndexBuildPromise) return fileIndexBuildPromise;

  fileIndexBuildPromise = buildFileIndex().then((entries) => {
    cachedFileIndex = entries;
    fileIndexTimestamp = Date.now();
    fileIndexBuildPromise = null;
    return entries;
  });

  return fileIndexBuildPromise;
}

filesRouter.get("/find/files", async (context) => {
  const query = context.req.query("query") ?? "";
  const fileIndex = await getFileIndex();

  if (!query) {
    const recentFiles = fileIndex.slice(0, MAX_FILE_SEARCH_RESULTS).map((entry) => entry.path);
    return context.json({ files: recentFiles });
  }

  const results = fuzzysort.go(query, fileIndex, {
    keys: ["path", "name"],
    limit: MAX_FILE_SEARCH_RESULTS,
  });

  const matchedFiles = results.map((result) => result.obj.path);
  return context.json({ files: matchedFiles });
});
