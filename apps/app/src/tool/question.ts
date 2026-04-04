import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";
import { Bus, Events } from "@/bus/index.ts";

const QUESTION_TIMEOUT_MS = 300_000;

export interface QuestionInfo {
  id: string;
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
}

interface PendingQuestion {
  sessionId: string;
  questions: QuestionInfo[];
  resolve: (answers: Record<string, string[]>) => void;
  reject: (reason: string) => void;
}

const pendingQuestions = new Map<string, PendingQuestion>();

export function replyToQuestion(sessionId: string, answers: Record<string, string[]>): boolean {
  const pending = pendingQuestions.get(sessionId);
  if (!pending) return false;
  pending.resolve(answers);
  pendingQuestions.delete(sessionId);
  Bus.publish(Events.Question.Replied, { sessionId, answers });
  return true;
}

export function rejectQuestion(sessionId: string): boolean {
  const pending = pendingQuestions.get(sessionId);
  if (!pending) return false;
  pending.reject("rejected");
  pendingQuestions.delete(sessionId);
  Bus.publish(Events.Question.Rejected, { sessionId });
  return true;
}

export function hasPendingQuestion(sessionId: string): boolean {
  return pendingQuestions.has(sessionId);
}

export const questionTool = defineTool({
  id: "question",
  description:
    "Ask the user structured questions with selectable options. Use ONLY when you genuinely need user input to proceed — do NOT re-ask what the user already told you. Each question has a short header (for tabs) and a full question text, with options that have labels and descriptions.",
  parameters: z.object({
    questions: z
      .array(
        z.object({
          id: z.string().describe("Unique identifier for this question"),
          question: z.string().describe("Complete question text"),
          header: z.string().describe("Very short label for tab header (max 30 chars)"),
          options: z
            .array(
              z.object({
                label: z.string().describe("Display text (1-5 words, concise)"),
                description: z.string().describe("Explanation of this choice"),
              }),
            )
            .min(2)
            .describe("Available options for the user to choose from"),
          multiple: z
            .boolean()
            .optional()
            .describe("If true, the user can select multiple options"),
        }),
      )
      .min(1)
      .max(5),
  }),
  async execute(args, context) {
    if (pendingQuestions.has(context.sessionId)) {
      return {
        title: "question",
        content: "A question is already pending for this session. Wait for the user to answer.",
      };
    }

    const questionsWithCustom: QuestionInfo[] = args.questions.map((q) => ({
      ...q,
      custom: true,
    }));

    try {
      const answers = await new Promise<Record<string, string[]>>((resolve, reject) => {
        const pending: PendingQuestion = {
          sessionId: context.sessionId,
          questions: questionsWithCustom,
          resolve,
          reject: (reason) => reject(new Error(reason)),
        };
        pendingQuestions.set(context.sessionId, pending);

        Bus.publish(Events.Question.Asked, {
          sessionId: context.sessionId,
          messageId: context.messageId,
          questions: questionsWithCustom,
        });

        const timeout = setTimeout(() => {
          if (pendingQuestions.has(context.sessionId)) {
            pendingQuestions.delete(context.sessionId);
            reject(new Error("timeout"));
          }
        }, QUESTION_TIMEOUT_MS);

        const originalResolve = pending.resolve;
        const originalReject = pending.reject;
        pending.resolve = (ans) => {
          clearTimeout(timeout);
          originalResolve(ans);
        };
        pending.reject = (reason) => {
          clearTimeout(timeout);
          originalReject(reason);
        };
      });

      const lines = args.questions.map((q) => {
        const selected = answers[q.id] ?? [];
        if (selected.length === 0) return `${q.question}: (no selection)`;
        return `${q.question}=${selected.join(", ")}`;
      });

      return {
        title: "question",
        content: lines.join("\n"),
        metadata: { answers },
      };
    } catch {
      return {
        title: "question",
        content: "The user dismissed the question. Use your best judgment and proceed.",
      };
    }
  },
});
