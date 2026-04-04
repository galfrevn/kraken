import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  filePath: string;
  directory: string;
}

function parseSkillFrontmatter(rawContent: string): {
  name: string;
  description: string;
  body: string;
} | null {
  if (!rawContent.startsWith("---")) return null;

  const closingDashIndex = rawContent.indexOf("---", 3);
  if (closingDashIndex === -1) return null;

  const frontmatterBlock = rawContent.slice(3, closingDashIndex).trim();
  const body = rawContent.slice(closingDashIndex + 3).trim();

  let name = "";
  let description = "";

  for (const line of frontmatterBlock.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("name:")) {
      name = trimmedLine
        .slice(5)
        .trim()
        .replace(/^["']|["']$/g, "");
    } else if (trimmedLine.startsWith("description:")) {
      description = trimmedLine
        .slice(12)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  if (!name) return null;

  return { name, description, body };
}

function findSkillFiles(searchDirectory: string): string[] {
  const skillFiles: string[] = [];

  if (!existsSync(searchDirectory)) return skillFiles;

  function scanRecursively(currentDirectory: string): void {
    try {
      const entries = readdirSync(currentDirectory);
      for (const entry of entries) {
        const fullPath = join(currentDirectory, entry);
        try {
          const entryStat = statSync(fullPath);
          if (entryStat.isDirectory()) {
            scanRecursively(fullPath);
          } else if (entry === "SKILL.md") {
            skillFiles.push(fullPath);
          }
        } catch {}
      }
    } catch {}
  }

  scanRecursively(searchDirectory);
  return skillFiles;
}

function listCompanionFiles(skillDirectory: string): string[] {
  const MAX_COMPANION_FILES = 20;
  const files: string[] = [];

  function scan(directory: string, prefix: string): void {
    try {
      for (const entry of readdirSync(directory)) {
        if (entry === "SKILL.md") continue;
        const fullPath = join(directory, entry);
        const relativePath = prefix ? `${prefix}/${entry}` : entry;
        try {
          if (statSync(fullPath).isDirectory()) {
            scan(fullPath, relativePath);
          } else {
            files.push(relativePath);
          }
        } catch {}
      }
    } catch {}
  }

  scan(skillDirectory, "");
  return files.slice(0, MAX_COMPANION_FILES);
}

let cachedSkills: SkillDefinition[] | null = null;

export function discoverSkills(): SkillDefinition[] {
  if (cachedSkills) return cachedSkills;

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const skills: SkillDefinition[] = [];

  const searchDirectories = [
    join(homeDirectory, ".kraken", "skills"),
    join(process.cwd(), ".kraken", "skills"),
    join(process.cwd(), "packages", "skills"),
    join(process.cwd(), ".agents", "skills"),
  ];

  for (const searchDirectory of searchDirectories) {
    const skillFiles = findSkillFiles(searchDirectory);

    for (const skillFilePath of skillFiles) {
      try {
        const rawContent = readFileSync(skillFilePath, "utf-8");
        const parsed = parseSkillFrontmatter(rawContent);
        if (!parsed) continue;

        if (skills.some((existing) => existing.name === parsed.name)) continue;

        skills.push({
          name: parsed.name,
          description: parsed.description,
          content: parsed.body,
          filePath: skillFilePath,
          directory: dirname(skillFilePath),
        });
      } catch {}
    }
  }

  cachedSkills = skills;
  return skills;
}

export function loadSkillByName(skillName: string): SkillDefinition | undefined {
  const availableSkills = discoverSkills();
  return availableSkills.find((skill) => skill.name === skillName);
}

export function formatSkillContent(skill: SkillDefinition): string {
  const companionFiles = listCompanionFiles(skill.directory);
  const companionSection =
    companionFiles.length > 0
      ? `\n\nCompanion files in ${skill.directory}:\n${companionFiles.map((file) => `  - ${file}`).join("\n")}`
      : "";

  return `<skill_instructions>
# Skill: ${skill.name}

${skill.content}${companionSection}
</skill_instructions>`;
}

export function buildSkillCatalog(): string {
  const availableSkills = discoverSkills();
  if (availableSkills.length === 0) return "";

  const skillEntries = availableSkills
    .map((skill) => `- **${skill.name}**: ${skill.description}`)
    .join("\n");

  return `\n\n# Skills
Skills provide specialized instructions for specific tasks. Use the skill tool to load a skill when a task matches its description.

${skillEntries}`;
}
