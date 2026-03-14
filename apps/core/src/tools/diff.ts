import { join } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const MAX_DIFF_LINES = 500;

export const diffFilesTool: Tool = {
  definition: {
    name: "diff_files",
    description: "Compare two files and show unified diff output.",
    parameters: [
      {
        name: "file_a",
        type: "string",
        description: "Relative path to the first file",
        required: true,
      },
      {
        name: "file_b",
        type: "string",
        description: "Relative path to the second file",
        required: true,
      },
      {
        name: "context",
        type: "number",
        description: "Number of context lines around changes (default: 3)",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const fileA = parameters["file_a"] as string;
    const fileB = parameters["file_b"] as string;
    const contextLines = Math.max(0, Math.min(Number(parameters["context"]) || 3, 10));

    const absoluteA = join(context.workingDirectory, fileA);
    const absoluteB = join(context.workingDirectory, fileB);

    const bunFileA = Bun.file(absoluteA);
    const bunFileB = Bun.file(absoluteB);

    if (!(await bunFileA.exists())) {
      return { success: false, output: "", error: `file not found: ${fileA}` };
    }
    if (!(await bunFileB.exists())) {
      return { success: false, output: "", error: `file not found: ${fileB}` };
    }

    const contentA = await bunFileA.text();
    const contentB = await bunFileB.text();

    if (contentA === contentB) {
      return { success: true, output: `${fileA} and ${fileB} are identical` };
    }

    const linesA = contentA.split(/\r?\n/);
    const linesB = contentB.split(/\r?\n/);

    const diffOutput = computeUnifiedDiff(linesA, linesB, fileA, fileB, contextLines);

    if (diffOutput.length > MAX_DIFF_LINES) {
      const truncated = diffOutput.slice(0, MAX_DIFF_LINES);
      truncated.push(`\n... truncated (${diffOutput.length - MAX_DIFF_LINES} more lines)`);
      return { success: true, output: truncated.join("\n") };
    }

    return { success: true, output: diffOutput.join("\n") };
  },
};

interface EditOp {
  type: "equal" | "insert" | "delete";
  lineA?: number;
  lineB?: number;
  text: string;
}

function computeUnifiedDiff(
  linesA: string[],
  linesB: string[],
  nameA: string,
  nameB: string,
  contextSize: number,
): string[] {
  const ops = computeEditScript(linesA, linesB);
  const output: string[] = [`--- ${nameA}`, `+++ ${nameB}`];
  const hunks = groupIntoHunks(ops, contextSize);

  for (const hunk of hunks) {
    const startA = hunk.startA + 1;
    const startB = hunk.startB + 1;
    output.push(`@@ -${startA},${hunk.countA} +${startB},${hunk.countB} @@`);

    for (const op of hunk.ops) {
      switch (op.type) {
        case "equal":
          output.push(` ${op.text}`);
          break;
        case "delete":
          output.push(`-${op.text}`);
          break;
        case "insert":
          output.push(`+${op.text}`);
          break;
      }
    }
  }

  return output;
}

function computeEditScript(linesA: string[], linesB: string[]): EditOp[] {
  const lengthA = linesA.length;
  const lengthB = linesB.length;

  if (lengthA + lengthB > 10_000) {
    return computeSimpleDiff(linesA, linesB);
  }

  const max = lengthA + lengthB;
  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize).fill(-1);
  const trace: Int32Array[] = [];

  v[max + 1] = 0;

  for (let d = 0; d <= max; d++) {
    trace.push(new Int32Array(v));

    for (let k = -d; k <= d; k += 2) {
      let x: number;

      const leftValue = v[max + k - 1] ?? -1;
      const rightValue = v[max + k + 1] ?? -1;

      if (k === -d || (k !== d && leftValue < rightValue)) {
        x = rightValue;
      } else {
        x = leftValue + 1;
      }

      let y = x - k;

      while (x < lengthA && y < lengthB && linesA[x] === linesB[y]) {
        x++;
        y++;
      }

      v[max + k] = x;

      if (x >= lengthA && y >= lengthB) {
        return backtrack(trace, linesA, linesB, max);
      }
    }
  }

  return computeSimpleDiff(linesA, linesB);
}

function backtrack(trace: Int32Array[], linesA: string[], linesB: string[], max: number): EditOp[] {
  const ops: EditOp[] = [];
  let x = linesA.length;
  let y = linesB.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d];
    if (!snapshot) continue;

    const k = x - y;

    let prevK: number;
    const leftValue = snapshot[max + k - 1] ?? -1;
    const rightValue = snapshot[max + k + 1] ?? -1;

    if (k === -d || (k !== d && leftValue < rightValue)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = snapshot[max + prevK] ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: "equal", lineA: x, lineB: y, text: linesA[x] ?? "" });
    }

    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ type: "insert", lineB: y, text: linesB[y] ?? "" });
      } else {
        x--;
        ops.push({ type: "delete", lineA: x, text: linesA[x] ?? "" });
      }
    }
  }

  return ops.reverse();
}

function computeSimpleDiff(linesA: string[], linesB: string[]): EditOp[] {
  const ops: EditOp[] = [];

  for (let i = 0; i < linesA.length; i++) {
    ops.push({ type: "delete", lineA: i, text: linesA[i] ?? "" });
  }
  for (let i = 0; i < linesB.length; i++) {
    ops.push({ type: "insert", lineB: i, text: linesB[i] ?? "" });
  }

  return ops;
}

interface Hunk {
  startA: number;
  startB: number;
  countA: number;
  countB: number;
  ops: EditOp[];
}

function groupIntoHunks(ops: EditOp[], contextSize: number): Hunk[] {
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op && op.type !== "equal") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  const hunks: Hunk[] = [];
  const firstChangeIndex = changeIndices[0] ?? 0;
  let currentStart = Math.max(0, firstChangeIndex - contextSize);
  let currentEnd = Math.min(ops.length - 1, firstChangeIndex + contextSize);

  for (let i = 1; i < changeIndices.length; i++) {
    const changeIndex = changeIndices[i] ?? 0;
    const newStart = Math.max(0, changeIndex - contextSize);

    if (newStart <= currentEnd + 1) {
      currentEnd = Math.min(ops.length - 1, changeIndex + contextSize);
    } else {
      hunks.push(buildHunk(ops, currentStart, currentEnd));
      currentStart = newStart;
      currentEnd = Math.min(ops.length - 1, changeIndex + contextSize);
    }
  }

  hunks.push(buildHunk(ops, currentStart, currentEnd));
  return hunks;
}

function buildHunk(ops: EditOp[], start: number, end: number): Hunk {
  const hunkOps = ops.slice(start, end + 1);
  let countA = 0;
  let countB = 0;
  let startA = 0;
  let startB = 0;
  let foundFirst = false;

  for (const op of hunkOps) {
    if (!foundFirst) {
      startA = op.lineA ?? op.lineB ?? 0;
      startB = op.lineB ?? op.lineA ?? 0;
      foundFirst = true;
    }

    switch (op.type) {
      case "equal":
        countA++;
        countB++;
        break;
      case "delete":
        countA++;
        break;
      case "insert":
        countB++;
        break;
    }
  }

  return { startA, startB, countA, countB, ops: hunkOps };
}
