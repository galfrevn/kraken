import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { discoverSkills, loadSkillByName, formatSkillContent } from "@/skill/index.ts";

export const skillTool = defineTool({
  id: "skill",
  description: buildSkillToolDescription(),
  parameters: z.object({
    name: z.string().describe("The name of the skill to load"),
  }),
  async execute(args, _context) {
    const skill = loadSkillByName(args.name);

    if (!skill) {
      const availableSkills = discoverSkills();
      const availableNames = availableSkills.map((s) => s.name).join(", ");
      return {
        title: `Skill not found: ${args.name}`,
        content: availableNames
          ? `Skill "${args.name}" not found. Available skills: ${availableNames}`
          : `Skill "${args.name}" not found. No skills are installed.`,
      };
    }

    return {
      title: `Loaded skill: ${skill.name}`,
      content: formatSkillContent(skill),
    };
  },
});

function buildSkillToolDescription(): string {
  return "Load a specialized skill with instructions for a specific task. See the Skills section in the system prompt for available skills.";
}
