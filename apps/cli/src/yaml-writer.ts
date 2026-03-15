import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KRAKEN_HOME } from "@/constants.ts";

const CONFIGURATION_FILE_NAME = "kraken.yml";

export function readConfigFile(): string | null {
  const configurationFilePath = join(KRAKEN_HOME, CONFIGURATION_FILE_NAME);
  if (!existsSync(configurationFilePath)) return null;
  return readFileSync(configurationFilePath, "utf-8");
}

export function writeConfigFile(fileContents: string): void {
  const configurationFilePath = join(KRAKEN_HOME, CONFIGURATION_FILE_NAME);
  writeFileSync(configurationFilePath, fileContents);
}

export function serializeYamlValue(
  value: unknown,
  indentationLevel: number,
): string {
  const indentationSpaces = " ".repeat(indentationLevel * 2);

  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);

  if (typeof value === "string") {
    const requiresQuoting =
      value.includes(":") ||
      value.includes("#") ||
      value.includes("{") ||
      value.includes("}") ||
      value.includes("[") ||
      value.includes("]") ||
      value.includes(",") ||
      value.includes("&") ||
      value.includes("*") ||
      value.includes("!") ||
      value.includes("|") ||
      value.includes(">") ||
      value.includes("'") ||
      value.includes('"') ||
      value.includes("%") ||
      value.includes("@") ||
      value.includes("`") ||
      value.startsWith(" ") ||
      value.endsWith(" ") ||
      value === "";

    if (requiresQuoting) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const serializedArrayItems: string[] = [];
    for (const arrayElement of value) {
      if (typeof arrayElement === "object" && arrayElement !== null && !Array.isArray(arrayElement)) {
        const objectEntries = Object.entries(arrayElement as Record<string, unknown>);
        const firstEntryLines: string[] = [];
        for (let entryIndex = 0; entryIndex < objectEntries.length; entryIndex++) {
          const [entryKey, entryValue] = objectEntries[entryIndex]!;
          const serializedEntryValue = serializeYamlValue(entryValue, indentationLevel + 2);
          if (entryIndex === 0) {
            firstEntryLines.push(`${indentationSpaces}- ${entryKey}: ${serializedEntryValue}`);
          } else {
            firstEntryLines.push(`${indentationSpaces}  ${entryKey}: ${serializedEntryValue}`);
          }
        }
        serializedArrayItems.push(firstEntryLines.join("\n"));
      } else {
        const serializedElementValue = serializeYamlValue(arrayElement, indentationLevel + 1);
        serializedArrayItems.push(`${indentationSpaces}- ${serializedElementValue}`);
      }
    }
    return "\n" + serializedArrayItems.join("\n");
  }

  if (typeof value === "object") {
    const objectLines: string[] = [];
    for (const [objectKey, objectValue] of Object.entries(value as Record<string, unknown>)) {
      const serializedObjectValue = serializeYamlValue(objectValue, indentationLevel + 1);
      if (typeof objectValue === "object" && objectValue !== null && !Array.isArray(objectValue)) {
        objectLines.push(`${indentationSpaces}${objectKey}:`);
        objectLines.push(serializedObjectValue);
      } else if (Array.isArray(objectValue) && objectValue.length > 0) {
        objectLines.push(`${indentationSpaces}${objectKey}:${serializedObjectValue}`);
      } else {
        objectLines.push(`${indentationSpaces}${objectKey}: ${serializedObjectValue}`);
      }
    }
    return objectLines.join("\n");
  }

  return String(value);
}

export function appendYamlArrayItem(
  fileContents: string,
  sectionPath: string[],
  itemToAppend: Record<string, unknown>,
): string {
  const fileLines = fileContents.split("\n");

  const sectionSearchResult = findSectionInYaml(fileLines, sectionPath);

  if (!sectionSearchResult.found) {
    const newSectionLines = buildNewSection(sectionPath, itemToAppend);
    const trimmedFileContents = fileContents.trimEnd();
    return trimmedFileContents + "\n\n" + newSectionLines.join("\n") + "\n";
  }

  const targetIndentationLevel = sectionPath.length;
  const targetIndentation = " ".repeat(targetIndentationLevel * 2);
  const insertionLineIndex = sectionSearchResult.sectionEndLineIndex;

  const currentLineAtInsertion = fileLines[insertionLineIndex - 1] ?? "";
  const sectionIsEmptyArray =
    currentLineAtInsertion.trim().endsWith("[]") ||
    currentLineAtInsertion.trim().endsWith(": []");

  if (sectionIsEmptyArray) {
    const lastSectionKey = sectionPath[sectionPath.length - 1]!;
    const parentIndentation = " ".repeat((sectionPath.length - 1) * 2);
    fileLines[insertionLineIndex - 1] = `${parentIndentation}${lastSectionKey}:`;
    const serializedItemLines = serializeArrayItemLines(itemToAppend, targetIndentationLevel);
    fileLines.splice(insertionLineIndex, 0, ...serializedItemLines.map((line) => targetIndentation + line));
    return fileLines.join("\n");
  }

  const serializedItemLines = serializeArrayItemLines(itemToAppend, targetIndentationLevel);
  fileLines.splice(insertionLineIndex, 0, ...serializedItemLines.map((line) => targetIndentation + line));
  return fileLines.join("\n");
}

export function removeYamlArrayItemByName(
  fileContents: string,
  sectionPath: string[],
  itemNameToRemove: string,
): string {
  const fileLines = fileContents.split("\n");
  const targetIndentation = " ".repeat(sectionPath.length * 2);
  const namePatternToMatch = `${targetIndentation}- name: ${itemNameToRemove}`;
  const quotedNamePatternToMatch = `${targetIndentation}- name: "${itemNameToRemove}"`;
  const singleQuotedNamePatternToMatch = `${targetIndentation}- name: '${itemNameToRemove}'`;

  let itemStartLineIndex = -1;

  for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
    const currentLine = fileLines[lineIndex]!;
    if (
      currentLine === namePatternToMatch ||
      currentLine === quotedNamePatternToMatch ||
      currentLine === singleQuotedNamePatternToMatch ||
      currentLine.startsWith(namePatternToMatch + " ") ||
      currentLine.startsWith(quotedNamePatternToMatch + " ") ||
      currentLine.startsWith(singleQuotedNamePatternToMatch + " ")
    ) {
      itemStartLineIndex = lineIndex;
      break;
    }
  }

  if (itemStartLineIndex === -1) return fileContents;

  let itemEndLineIndex = itemStartLineIndex + 1;
  const itemBaseIndentationLength = targetIndentation.length;

  while (itemEndLineIndex < fileLines.length) {
    const subsequentLine = fileLines[itemEndLineIndex]!;
    if (subsequentLine.trim() === "") {
      itemEndLineIndex++;
      continue;
    }
    const subsequentLineIndentation = subsequentLine.length - subsequentLine.trimStart().length;
    if (subsequentLineIndentation <= itemBaseIndentationLength) break;
    if (subsequentLine.trimStart().startsWith("- ") && subsequentLineIndentation === itemBaseIndentationLength) break;
    itemEndLineIndex++;
  }

  while (
    itemEndLineIndex > itemStartLineIndex + 1 &&
    fileLines[itemEndLineIndex - 1]?.trim() === ""
  ) {
    itemEndLineIndex--;
  }

  fileLines.splice(itemStartLineIndex, itemEndLineIndex - itemStartLineIndex);
  return fileLines.join("\n");
}

interface SectionSearchResult {
  found: boolean;
  sectionEndLineIndex: number;
}

function findSectionInYaml(
  fileLines: string[],
  sectionPath: string[],
): SectionSearchResult {
  let currentSearchLineIndex = 0;
  let currentPathDepth = 0;

  while (currentPathDepth < sectionPath.length && currentSearchLineIndex < fileLines.length) {
    const expectedSectionKey = sectionPath[currentPathDepth]!;
    const expectedIndentation = " ".repeat(currentPathDepth * 2);
    const expectedLinePrefix = `${expectedIndentation}${expectedSectionKey}:`;

    let sectionFound = false;
    for (let lineIndex = currentSearchLineIndex; lineIndex < fileLines.length; lineIndex++) {
      const currentLine = fileLines[lineIndex]!;
      if (currentLine.startsWith(expectedLinePrefix)) {
        currentSearchLineIndex = lineIndex + 1;
        currentPathDepth++;
        sectionFound = true;
        break;
      }
    }

    if (!sectionFound) {
      return { found: false, sectionEndLineIndex: fileLines.length };
    }
  }

  if (currentPathDepth < sectionPath.length) {
    return { found: false, sectionEndLineIndex: fileLines.length };
  }

  const sectionIndentationLevel = (sectionPath.length - 1) * 2;
  let sectionEndLineIndex = currentSearchLineIndex;

  while (sectionEndLineIndex < fileLines.length) {
    const currentLine = fileLines[sectionEndLineIndex]!;
    if (currentLine.trim() === "") {
      sectionEndLineIndex++;
      continue;
    }
    const currentLineIndentation = currentLine.length - currentLine.trimStart().length;
    if (currentLineIndentation <= sectionIndentationLevel && !currentLine.trim().startsWith("-")) break;
    sectionEndLineIndex++;
  }

  return { found: true, sectionEndLineIndex };
}

function buildNewSection(
  sectionPath: string[],
  itemToAppend: Record<string, unknown>,
): string[] {
  const generatedLines: string[] = [];

  for (let pathIndex = 0; pathIndex < sectionPath.length; pathIndex++) {
    const indentation = " ".repeat(pathIndex * 2);
    if (pathIndex < sectionPath.length - 1) {
      generatedLines.push(`${indentation}${sectionPath[pathIndex]}:`);
    } else {
      generatedLines.push(`${indentation}${sectionPath[pathIndex]}:`);
      const targetIndentation = " ".repeat((pathIndex + 1) * 2);
      const serializedItemLines = serializeArrayItemLines(itemToAppend, pathIndex + 1);
      for (const serializedLine of serializedItemLines) {
        generatedLines.push(targetIndentation + serializedLine);
      }
    }
  }

  return generatedLines;
}

function serializeArrayItemLines(
  itemToSerialize: Record<string, unknown>,
  indentationLevel: number,
): string[] {
  const resultLines: string[] = [];
  const objectEntries = Object.entries(itemToSerialize);

  for (let entryIndex = 0; entryIndex < objectEntries.length; entryIndex++) {
    const [entryKey, entryValue] = objectEntries[entryIndex]!;
    const serializedValue = serializeYamlValue(entryValue, indentationLevel + 1);

    if (entryIndex === 0) {
      if (Array.isArray(entryValue) && entryValue.length > 0) {
        resultLines.push(`- ${entryKey}:${serializedValue}`);
      } else if (typeof entryValue === "object" && entryValue !== null && !Array.isArray(entryValue)) {
        resultLines.push(`- ${entryKey}:`);
        resultLines.push(serializedValue);
      } else {
        resultLines.push(`- ${entryKey}: ${serializedValue}`);
      }
    } else {
      if (Array.isArray(entryValue) && entryValue.length > 0) {
        resultLines.push(`  ${entryKey}:${serializedValue}`);
      } else if (typeof entryValue === "object" && entryValue !== null && !Array.isArray(entryValue)) {
        resultLines.push(`  ${entryKey}:`);
        resultLines.push(serializedValue);
      } else {
        resultLines.push(`  ${entryKey}: ${serializedValue}`);
      }
    }
  }

  return resultLines;
}
