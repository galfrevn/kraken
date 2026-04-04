export function createUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
  contextLines = 3,
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const hunks: string[] = [];
  hunks.push(`--- a/${filePath}`);
  hunks.push(`+++ b/${filePath}`);

  let i = 0;
  let j = 0;
  const changes: Array<{
    type: "context" | "remove" | "add";
    oldLine: number;
    newLine: number;
    text: string;
  }> = [];

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      changes.push({ type: "context", oldLine: i + 1, newLine: j + 1, text: oldLines[i]! });
      i++;
      j++;
    } else {
      let oi = i;
      let nj = j;
      while (oi < oldLines.length && (nj >= newLines.length || oldLines[oi] !== newLines[nj])) {
        const found = newLines.indexOf(oldLines[oi]!, nj);
        if (found !== -1 && found - nj < 10) {
          break;
        }
        oi++;
      }
      while (nj < newLines.length && (oi >= oldLines.length || newLines[nj] !== oldLines[oi])) {
        const found = oldLines.indexOf(newLines[nj]!, oi);
        if (found !== -1 && found - oi < 10) {
          break;
        }
        nj++;
      }
      for (let k = i; k < oi; k++) {
        changes.push({ type: "remove", oldLine: k + 1, newLine: j + 1, text: oldLines[k]! });
      }
      for (let k = j; k < nj; k++) {
        changes.push({ type: "add", oldLine: oi + 1, newLine: k + 1, text: newLines[k]! });
      }
      i = oi;
      j = nj;
    }
  }

  let hunkStart = -1;
  for (let idx = 0; idx < changes.length; idx++) {
    const change = changes[idx]!;
    if (change.type !== "context") {
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(changes.length, idx + contextLines + 1);

      if (hunkStart === -1) hunkStart = start;

      let hunkEnd = end;
      for (let peek = idx + 1; peek < changes.length && peek <= end; peek++) {
        if (changes[peek]!.type !== "context") {
          idx = peek;
          hunkEnd = Math.min(changes.length, peek + contextLines + 1);
        }
      }

      const hunkChanges = changes.slice(hunkStart, hunkEnd);
      const oldStart = hunkChanges[0]?.oldLine ?? 1;
      const newStart = hunkChanges[0]?.newLine ?? 1;
      const oldCount = hunkChanges.filter((c) => c.type !== "add").length;
      const newCount = hunkChanges.filter((c) => c.type !== "remove").length;

      hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
      for (const c of hunkChanges) {
        if (c.type === "context") hunks.push(` ${c.text}`);
        else if (c.type === "remove") hunks.push(`-${c.text}`);
        else if (c.type === "add") hunks.push(`+${c.text}`);
      }

      hunkStart = -1;
    }
  }

  return hunks.join("\n");
}
