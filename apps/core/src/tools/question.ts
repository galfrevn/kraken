import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  title: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export interface PendingQuestions {
  id: string;
  items: QuestionItem[];
  resolve: (answers: QuestionAnswer[]) => void;
}

export type QuestionHandler = (pending: PendingQuestions) => void;

export function createAskQuestionTool(onQuestion: QuestionHandler): Tool {
  return {
    definition: {
      name: "ask_question",
      description:
        "Ask the user one or more questions with predefined options. Use this when you need clarification, choices, or preferences from the user. " +
        "Send ALL related questions in a single call. Each question has a short title (for tab navigation), the question text, and options. " +
        "The user can also type a free-text answer for any question. The user can dismiss with Esc (unanswered questions return '(no answer)').",
      parameters: [
        {
          name: "questions",
          type: "string",
          description:
            'JSON array of question objects. Each has "title" (short tab label), "question" (full text), "options" (array of {label, description?}), and optional "multiple" (boolean, default false — when true the user can select multiple options). ' +
            'Example: [{"title":"Language","question":"What language do you prefer?","options":[{"label":"Python","description":"Simple and popular"},{"label":"Rust"}]},{"title":"Features","question":"Which features?","multiple":true,"options":[{"label":"Auth"},{"label":"DB"},{"label":"API"}]}]',
          required: true,
        },
      ],
    },
    async execute(
      parameters: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const questionsRaw = parameters["questions"] as string;

      if (!questionsRaw) {
        return { success: false, output: "", error: "questions parameter is required" };
      }

      let items: QuestionItem[];
      try {
        const parsed = JSON.parse(questionsRaw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return { success: false, output: "", error: "questions must be a non-empty JSON array" };
        }
        items = parsed.map((q: Record<string, unknown>) => {
          const options = Array.isArray(q.options)
            ? (q.options as Record<string, unknown>[]).map((o) => ({
                label: String(o.label ?? ""),
                description: o.description ? String(o.description) : undefined,
              }))
            : [];
          return {
            title: String(q.title ?? ""),
            question: String(q.question ?? ""),
            options,
            multiple: q.multiple === true,
          };
        });
      } catch {
        return { success: false, output: "", error: "questions must be valid JSON" };
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      return new Promise<ToolResult>((resolve) => {
        onQuestion({
          id,
          items,
          resolve: (answers: QuestionAnswer[]) => {
            const lines = ["# Questions", ""];
            for (const a of answers) {
              lines.push(a.question);
              lines.push(a.answer);
              lines.push("");
            }
            resolve({ success: true, output: lines.join("\n") });
          },
        });
      });
    },
  };
}
