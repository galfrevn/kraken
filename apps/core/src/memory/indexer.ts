import { join, relative, extname, basename } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { AgentDatabase } from "@/storage/database.ts";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  "gen",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".rb"]);

const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
  ".env.example",
]);

const MAX_SCAN_DEPTH = 6;
const MAX_FILES_TO_ANALYZE = 100;
const INDEXER_SOURCE = "indexer";

interface DirectoryEntry {
  relativePath: string;
  absolutePath: string;
  isDirectory: boolean;
  extension: string;
  depth: number;
}

interface ProjectManifest {
  name?: string;
  description?: string;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
  language: string;
}

interface ProjectStructure {
  rootFiles: string[];
  directories: Map<string, string[]>;
  sourceFileCount: number;
  languages: Map<string, number>;
}

export interface IndexingResult {
  factsCreated: number;
  filesScanned: number;
  duration: number;
}

export class ProjectIndexer {
  private database: AgentDatabase;

  constructor(database: AgentDatabase) {
    this.database = database;
  }

  async indexProject(workingDirectory: string): Promise<IndexingResult> {
    const startTime = Date.now();
    this.clearIndexerFacts();

    const entries = this.walkDirectory(workingDirectory, workingDirectory, 0);
    const structure = this.analyzeStructure(entries);
    const manifests = await this.readManifests(entries);

    let factsCreated = 0;

    factsCreated += this.storeProjectOverview(structure, manifests, workingDirectory);
    factsCreated += this.storeDirectoryMap(structure);
    factsCreated += this.storeDependencies(manifests);
    factsCreated += this.storeLanguageBreakdown(structure);
    factsCreated += await this.storeKeyFileOutlines(entries);

    return {
      factsCreated,
      filesScanned: entries.length,
      duration: Date.now() - startTime,
    };
  }

  private clearIndexerFacts(): void {
    this.database.deleteFactsBySource(INDEXER_SOURCE);
  }

  private walkDirectory(rootPath: string, currentPath: string, depth: number): DirectoryEntry[] {
    if (depth > MAX_SCAN_DEPTH) return [];

    const entries: DirectoryEntry[] = [];

    let items: string[];
    try {
      items = readdirSync(currentPath);
    } catch {
      return entries;
    }

    for (const item of items) {
      if (item.startsWith(".") && !CONFIG_FILE_NAMES.has(item)) continue;

      const absolutePath = join(currentPath, item);
      const relativePath = relative(rootPath, absolutePath);

      let stats;
      try {
        stats = statSync(absolutePath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(item)) continue;

        entries.push({
          relativePath,
          absolutePath,
          isDirectory: true,
          extension: "",
          depth,
        });

        entries.push(...this.walkDirectory(rootPath, absolutePath, depth + 1));
      } else {
        entries.push({
          relativePath,
          absolutePath,
          isDirectory: false,
          extension: extname(item).toLowerCase(),
          depth,
        });
      }
    }

    return entries;
  }

  private analyzeStructure(entries: DirectoryEntry[]): ProjectStructure {
    const rootFiles: string[] = [];
    const directories = new Map<string, string[]>();
    const languages = new Map<string, number>();
    let sourceFileCount = 0;

    for (const entry of entries) {
      if (entry.isDirectory) {
        if (!directories.has(entry.relativePath)) {
          directories.set(entry.relativePath, []);
        }
        continue;
      }

      if (entry.depth === 0) {
        rootFiles.push(entry.relativePath);
      }

      const parentDir = entry.relativePath.includes("/")
        ? entry.relativePath.substring(0, entry.relativePath.lastIndexOf("/"))
        : ".";

      const existing = directories.get(parentDir) ?? [];
      existing.push(basename(entry.relativePath));
      directories.set(parentDir, existing);

      if (SOURCE_EXTENSIONS.has(entry.extension)) {
        sourceFileCount++;
        const language = extensionToLanguage(entry.extension);
        languages.set(language, (languages.get(language) ?? 0) + 1);
      }
    }

    return { rootFiles, directories, sourceFileCount, languages };
  }

  private async readManifests(entries: DirectoryEntry[]): Promise<ProjectManifest[]> {
    const manifests: ProjectManifest[] = [];

    const configEntries = entries.filter(
      (entry) => !entry.isDirectory && CONFIG_FILE_NAMES.has(basename(entry.relativePath)),
    );

    for (const entry of configEntries) {
      const fileName = basename(entry.relativePath);

      if (fileName === "package.json") {
        const manifest = await this.readPackageJson(entry.absolutePath);
        if (manifest) manifests.push(manifest);
      }

      if (fileName === "Cargo.toml") {
        const manifest = await this.readCargoToml(entry.absolutePath, entry.relativePath);
        if (manifest) manifests.push(manifest);
      }

      if (fileName === "go.mod") {
        const manifest = await this.readGoMod(entry.absolutePath, entry.relativePath);
        if (manifest) manifests.push(manifest);
      }
    }

    return manifests;
  }

  private async readPackageJson(absolutePath: string): Promise<ProjectManifest | undefined> {
    try {
      const content = await Bun.file(absolutePath).text();
      const parsed = JSON.parse(content);

      return {
        name: parsed.name,
        description: parsed.description,
        dependencies: Object.keys(parsed.dependencies ?? {}),
        devDependencies: Object.keys(parsed.devDependencies ?? {}),
        scripts: Object.keys(parsed.scripts ?? {}),
        language: "typescript",
      };
    } catch {
      return undefined;
    }
  }

  private async readCargoToml(
    absolutePath: string,
    _relativePath: string,
  ): Promise<ProjectManifest | undefined> {
    try {
      const content = await Bun.file(absolutePath).text();
      const dependencies: string[] = [];

      let inDependencies = false;
      for (const line of content.split("\n")) {
        if (line.match(/^\[dependencies\]/)) {
          inDependencies = true;
          continue;
        }
        if (line.match(/^\[/)) {
          inDependencies = false;
          continue;
        }
        if (inDependencies) {
          const match = line.match(/^(\w[\w-]*)\s*=/);
          if (match?.[1]) dependencies.push(match[1]);
        }
      }

      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);

      return {
        name: nameMatch?.[1],
        description: descMatch?.[1],
        dependencies,
        devDependencies: [],
        scripts: [],
        language: "rust",
      };
    } catch {
      return undefined;
    }
  }

  private async readGoMod(
    absolutePath: string,
    _relativePath: string,
  ): Promise<ProjectManifest | undefined> {
    try {
      const content = await Bun.file(absolutePath).text();
      const dependencies: string[] = [];

      let inRequire = false;
      for (const line of content.split("\n")) {
        if (line.trim() === "require (") {
          inRequire = true;
          continue;
        }
        if (line.trim() === ")") {
          inRequire = false;
          continue;
        }
        if (inRequire) {
          const match = line.trim().match(/^(\S+)\s/);
          if (match?.[1]) dependencies.push(match[1]);
        }
      }

      const moduleMatch = content.match(/^module\s+(\S+)/m);

      return {
        name: moduleMatch?.[1],
        dependencies,
        devDependencies: [],
        scripts: [],
        language: "go",
      };
    } catch {
      return undefined;
    }
  }

  private storeProjectOverview(
    structure: ProjectStructure,
    manifests: ProjectManifest[],
    workingDirectory: string,
  ): number {
    const projectName = basename(workingDirectory);
    const languageList = Array.from(structure.languages.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang} (${count} files)`)
      .join(", ");

    const rootManifest = manifests.find((m) => m.name && !m.name.startsWith("@"));
    const description = rootManifest?.description ? ` — ${rootManifest.description}` : "";

    const overview =
      `Project "${rootManifest?.name ?? projectName}"${description}. ` +
      `${structure.sourceFileCount} source files across ${structure.directories.size} directories. ` +
      `Languages: ${languageList || "none detected"}.`;

    this.database.insertFact("context", overview, INDEXER_SOURCE, ["project", "overview"]);
    return 1;
  }

  private storeDirectoryMap(structure: ProjectStructure): number {
    let factsCreated = 0;

    const topLevelDirs = Array.from(structure.directories.keys()).filter(
      (dir) => !dir.includes("/") && dir !== ".",
    );

    if (topLevelDirs.length === 0) return 0;

    const directoryDescriptions = topLevelDirs
      .map((dir) => {
        const purpose = inferDirectoryPurpose(dir);
        return `${dir}/ — ${purpose}`;
      })
      .join("\n");

    const fact = `Top-level directory structure:\n${directoryDescriptions}`;

    this.database.insertFact("architecture", fact, INDEXER_SOURCE, ["structure", "directories"]);
    factsCreated++;

    return factsCreated;
  }

  private storeDependencies(manifests: ProjectManifest[]): number {
    let factsCreated = 0;

    for (const manifest of manifests) {
      if (manifest.dependencies.length === 0) continue;

      const keyDependencies = manifest.dependencies.slice(0, 30);
      const truncated =
        manifest.dependencies.length > 30 ? ` (showing 30 of ${manifest.dependencies.length})` : "";

      const fact = `${manifest.name ?? "Unknown"} (${manifest.language}) dependencies${truncated}: ${keyDependencies.join(", ")}.`;

      const tags = ["dependencies", manifest.language];
      if (manifest.name) tags.push(manifest.name.replace(/[@/]/g, ""));

      this.database.insertFact("dependency", fact, INDEXER_SOURCE, tags);
      factsCreated++;

      if (manifest.scripts.length > 0) {
        const scriptsFact = `${manifest.name ?? "Unknown"} available scripts: ${manifest.scripts.join(", ")}.`;

        this.database.insertFact("context", scriptsFact, INDEXER_SOURCE, [
          "scripts",
          manifest.language,
        ]);
        factsCreated++;
      }
    }

    return factsCreated;
  }

  private storeLanguageBreakdown(structure: ProjectStructure): number {
    if (structure.languages.size <= 1) return 0;

    const breakdown = Array.from(structure.languages.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}: ${count} files`)
      .join(", ");

    const primaryLanguage = Array.from(structure.languages.entries()).sort(
      (a, b) => b[1] - a[1],
    )[0];

    const fact =
      `This is a polyglot project. Primary language: ${primaryLanguage?.[0] ?? "unknown"}. ` +
      `Breakdown: ${breakdown}.`;

    this.database.insertFact("architecture", fact, INDEXER_SOURCE, ["languages", "polyglot"]);
    return 1;
  }

  private async storeKeyFileOutlines(entries: DirectoryEntry[]): Promise<number> {
    const sourceFiles = entries.filter(
      (entry) => !entry.isDirectory && SOURCE_EXTENSIONS.has(entry.extension),
    );

    const keyFiles = sourceFiles
      .filter((entry) => isKeyFile(entry.relativePath))
      .slice(0, MAX_FILES_TO_ANALYZE);

    let factsCreated = 0;

    for (const entry of keyFiles) {
      try {
        const content = await Bun.file(entry.absolutePath).text();
        const lines = content.split("\n");

        const exports = extractExportedSymbols(lines, entry.extension);
        if (exports.length === 0) continue;

        const symbolList = exports.slice(0, 15).join(", ");
        const truncated = exports.length > 15 ? ` (+${exports.length - 15} more)` : "";

        const fact = `${entry.relativePath} exports: ${symbolList}${truncated}.`;

        this.database.insertFact("architecture", fact, INDEXER_SOURCE, [
          "exports",
          extensionToLanguage(entry.extension),
          ...inferFileTags(entry.relativePath),
        ]);
        factsCreated++;
      } catch {
        continue;
      }
    }

    return factsCreated;
  }
}

function extensionToLanguage(extension: string): string {
  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".rb":
      return "ruby";
    default:
      return "unknown";
  }
}

function inferDirectoryPurpose(directoryName: string): string {
  const purposes: Record<string, string> = {
    src: "source code",
    lib: "library code",
    apps: "applications / services",
    packages: "shared packages",
    test: "tests",
    tests: "tests",
    docs: "documentation",
    scripts: "build/utility scripts",
    config: "configuration",
    public: "static assets",
    assets: "static assets",
    proto: "protobuf definitions",
    gen: "generated code",
    tools: "tooling",
    bin: "executables",
    cmd: "command entrypoints",
    internal: "internal packages",
    api: "API definitions",
    migrations: "database migrations",
    fixtures: "test fixtures",
  };

  return purposes[directoryName] ?? "project directory";
}

function isKeyFile(relativePath: string): boolean {
  const fileName = basename(relativePath);
  const fileNameNoExt = fileName.replace(extname(fileName), "");

  if (fileNameNoExt === "index" || fileNameNoExt === "main" || fileNameNoExt === "mod") return true;
  if (fileNameNoExt === "schema" || fileNameNoExt === "types") return true;
  if (fileNameNoExt === "router" || fileNameNoExt === "routes") return true;
  if (fileNameNoExt === "config" || fileNameNoExt === "configuration") return true;

  if (relativePath.includes("__tests__") || relativePath.includes(".spec.")) return false;
  if (relativePath.includes(".test.")) return false;

  const parts = relativePath.split("/");
  if (parts.length <= 2) return true;
  if (parts.length <= 3 && parts.some((p) => p === "src")) return true;

  return false;
}

function inferFileTags(relativePath: string): string[] {
  const tags: string[] = [];
  const parts = relativePath.split("/");

  for (const part of parts) {
    if (["src", "lib", "apps", "packages"].includes(part)) continue;
    if (part.includes(".")) continue;
    tags.push(part);
  }

  return tags.slice(0, 3);
}

function extractExportedSymbols(lines: string[], extension: string): string[] {
  const symbols: string[] = [];

  if ([".ts", ".tsx", ".js", ".jsx"].includes(extension)) {
    for (const line of lines) {
      const trimmed = line.trimStart();

      let match = trimmed.match(/^export\s+(default\s+)?(?:class|abstract\s+class)\s+(\w+)/);
      if (match?.[2]) {
        symbols.push(match[2]);
        continue;
      }

      match = trimmed.match(/^export\s+(default\s+)?interface\s+(\w+)/);
      if (match?.[2]) {
        symbols.push(match[2]);
        continue;
      }

      match = trimmed.match(/^export\s+(default\s+)?type\s+(\w+)/);
      if (match?.[2]) {
        symbols.push(match[2]);
        continue;
      }

      match = trimmed.match(/^export\s+(default\s+)?(async\s+)?function\s+(\w+)/);
      if (match?.[3]) {
        symbols.push(match[3]);
        continue;
      }

      match = trimmed.match(/^export\s+const\s+(\w+)/);
      if (match?.[1]) {
        symbols.push(match[1]);
        continue;
      }

      match = trimmed.match(/^export\s+enum\s+(\w+)/);
      if (match?.[1]) {
        symbols.push(match[1]);
        continue;
      }
    }
  }

  if (extension === ".go") {
    for (const line of lines) {
      const trimmed = line.trimStart();
      const match = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?([A-Z]\w*)/);
      if (match?.[1]) symbols.push(match[1]);

      const typeMatch = trimmed.match(/^type\s+([A-Z]\w+)/);
      if (typeMatch?.[1]) symbols.push(typeMatch[1]);
    }
  }

  if (extension === ".rs") {
    for (const line of lines) {
      const trimmed = line.trimStart();
      const match = trimmed.match(/^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\s+(\w+)/);
      if (match?.[1]) symbols.push(match[1]);
    }
  }

  if (extension === ".py") {
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("class ") || trimmed.startsWith("def ")) {
        const match = trimmed.match(/^(?:class|def)\s+(\w+)/);
        if (match?.[1] && !match[1].startsWith("_")) symbols.push(match[1]);
      }
    }
  }

  return [...new Set(symbols)];
}
