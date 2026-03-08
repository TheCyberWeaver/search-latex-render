export type MathSegmentType = "inline" | "block";

export interface MathSegment {
  type: MathSegmentType;
  start: number;
  end: number;
  raw: string;
  startLine: number;
  endLine: number;
}

export interface ParsedMathDocument {
  text: string;
  lineStarts: number[];
  mathSegments: MathSegment[];
}

export interface RecoveryOptions {
  lineNumber?: number | null;
  visibleSnippet: string;
  contextChars: number;
  maxRenderedLineLength: number;
  maxBlockLength: number;
}

export interface RecoveryResult {
  excerpt: string;
  recoveredFromFile: boolean;
  usesBlockMath: boolean;
}

interface TextRange {
  start: number;
  end: number;
}

interface NormalizedTextMap {
  text: string;
  rawIndexByNormalizedIndex: number[];
}

const CJK_RE = /[\u3400-\u9fff]/;

export function parseMathDocument(text: string): ParsedMathDocument {
  const lineStarts = buildLineStarts(text);
  const mathSegments: MathSegment[] = [];
  let inFence: { marker: string; length: number } | null = null;
  let openBlockStart: number | null = null;

  for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const range = getLineRangeFromStarts(text, lineStarts, lineNumber);
    const line = text.slice(range.start, range.end);
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

    if (inFence) {
      if (fenceMatch && fenceMatch[1][0] === inFence.marker && fenceMatch[1].length >= inFence.length) {
        inFence = null;
      }
      continue;
    }

    if (fenceMatch) {
      inFence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    let index = 0;
    let codeTicks = 0;

    if (openBlockStart !== null) {
      const closing = findClosingDoubleDollar(line, 0);
      if (closing === -1) {
        continue;
      }

      mathSegments.push(createSegment("block", text, lineStarts, openBlockStart, range.start + closing + 2));
      openBlockStart = null;
      index = closing + 2;
    }

    while (index < line.length) {
      const char = line[index];

      if (char === "\\") {
        index += 2;
        continue;
      }

      if (codeTicks > 0) {
        if (line.startsWith("`".repeat(codeTicks), index)) {
          index += codeTicks;
          codeTicks = 0;
          continue;
        }

        index += 1;
        continue;
      }

      if (char === "`") {
        codeTicks = countRepeatedCharacters(line, index, "`");
        index += codeTicks;
        continue;
      }

      if (char !== "$") {
        index += 1;
        continue;
      }

      if (line[index + 1] === "$") {
        const closing = findClosingDoubleDollar(line, index + 2);
        if (closing === -1) {
          openBlockStart = range.start + index;
          break;
        }

        mathSegments.push(createSegment("block", text, lineStarts, range.start + index, range.start + closing + 2));
        index = closing + 2;
        continue;
      }

      const closing = findClosingInlineDollar(line, index + 1);
      if (closing === -1) {
        index += 1;
        continue;
      }

      const body = line.slice(index + 1, closing);
      if (!looksLikeInlineMath(body)) {
        index = closing + 1;
        continue;
      }

      mathSegments.push(createSegment("inline", text, lineStarts, range.start + index, range.start + closing + 1));
      index = closing + 1;
    }
  }

  return { text, lineStarts, mathSegments };
}

export function recoverSearchExcerpt(
  parsed: ParsedMathDocument,
  options: RecoveryOptions,
): RecoveryResult | null {
  const snippet = sanitizeSnippet(options.visibleSnippet);
  if (!snippet) {
    return null;
  }

  const snippetMath = parseMathDocument(snippet).mathSegments;
  const lineNumber = options.lineNumber ?? null;

  if (!lineNumber || !Number.isInteger(lineNumber) || lineNumber < 1) {
    if (snippetMath.length === 0) {
      return null;
    }

    return {
      excerpt: snippet,
      recoveredFromFile: false,
      usesBlockMath: snippetMath.some((segment) => segment.type === "block"),
    };
  }

  const lineRange = getLineRangeFromStarts(parsed.text, parsed.lineStarts, lineNumber);
  const line = parsed.text.slice(lineRange.start, lineRange.end);
  const overlappingSegments = parsed.mathSegments.filter(
    (segment) => segment.startLine <= lineNumber && segment.endLine >= lineNumber,
  );

  if (overlappingSegments.length === 0) {
    if (snippetMath.length === 0) {
      return null;
    }

    return {
      excerpt: snippet,
      recoveredFromFile: false,
      usesBlockMath: snippetMath.some((segment) => segment.type === "block"),
    };
  }

  const blockSegment = overlappingSegments.find((segment) => segment.type === "block");
  if (blockSegment) {
    if (blockSegment.raw.length > options.maxBlockLength) {
      return null;
    }

    return {
      excerpt: blockSegment.raw,
      recoveredFromFile: true,
      usesBlockMath: true,
    };
  }

  if (snippetMath.length > 0 && !snippetLooksPartial(snippet, line, overlappingSegments)) {
    return {
      excerpt: snippet,
      recoveredFromFile: false,
      usesBlockMath: false,
    };
  }

  const lineStart = lineRange.start;
  const excerpt = buildLineExcerpt(
    line,
    overlappingSegments.map((segment) => ({
      start: segment.start - lineStart,
      end: segment.end - lineStart,
    })),
    locateSnippetWithinLine(line, snippet),
    options.contextChars,
    options.maxRenderedLineLength,
  );

  if (!excerpt || parseMathDocument(excerpt).mathSegments.length === 0) {
    return null;
  }

  return {
    excerpt,
    recoveredFromFile: true,
    usesBlockMath: false,
  };
}

function buildLineExcerpt(
  line: string,
  mathRanges: TextRange[],
  anchor: TextRange | null,
  contextChars: number,
  maxRenderedLineLength: number,
): string {
  if (line.length <= maxRenderedLineLength) {
    return line.trim();
  }

  const mathStart = Math.min(...mathRanges.map((range) => range.start));
  const mathEnd = Math.max(...mathRanges.map((range) => range.end));
  const focusStart = Math.min(anchor?.start ?? mathStart, mathStart);
  const focusEnd = Math.max(anchor?.end ?? mathEnd, mathEnd);
  let sliceStart = Math.max(0, focusStart - contextChars);
  let sliceEnd = Math.min(line.length, focusEnd + contextChars);

  if (sliceEnd - sliceStart > maxRenderedLineLength) {
    const requiredWidth = mathEnd - mathStart;
    if (requiredWidth >= maxRenderedLineLength) {
      sliceStart = mathStart;
      sliceEnd = mathEnd;
    } else {
      const remaining = maxRenderedLineLength - requiredWidth;
      const leftPadding = Math.min(mathStart, Math.floor(remaining / 2));
      const rightPadding = remaining - leftPadding;
      sliceStart = Math.max(0, mathStart - leftPadding);
      sliceEnd = Math.min(line.length, mathEnd + rightPadding);

      if (sliceEnd - sliceStart < maxRenderedLineLength) {
        sliceStart = Math.max(0, sliceEnd - maxRenderedLineLength);
      }
    }
  }

  const body = line.slice(sliceStart, sliceEnd).trim();
  return `${sliceStart > 0 ? "…" : ""}${body}${sliceEnd < line.length ? "…" : ""}`;
}

function snippetLooksPartial(snippet: string, line: string, lineSegments: MathSegment[]): boolean {
  const normalizedSnippet = normalizeForComparison(stripEdgeEllipsis(snippet));
  const normalizedLine = normalizeForComparison(line);

  if (!normalizedSnippet) {
    return true;
  }

  if (snippet.includes("...") || snippet.includes("…")) {
    return true;
  }

  if (countUnescapedDollars(snippet) % 2 === 1) {
    return true;
  }

  if (normalizedLine.includes(normalizedSnippet) && normalizedSnippet !== normalizedLine) {
    return true;
  }

  return lineSegments.some((segment) => !normalizedSnippet.includes(normalizeForComparison(segment.raw)));
}

function locateSnippetWithinLine(line: string, snippet: string): TextRange | null {
  const rawSnippet = stripEdgeEllipsis(snippet);
  const exactIndex = line.indexOf(rawSnippet);
  if (exactIndex !== -1) {
    return { start: exactIndex, end: exactIndex + rawSnippet.length };
  }

  const normalizedLine = normalizeWithMap(line);
  const normalizedSnippet = normalizeForComparison(rawSnippet);
  if (!normalizedSnippet) {
    return null;
  }

  const normalizedIndex = normalizedLine.text.indexOf(normalizedSnippet);
  if (normalizedIndex === -1) {
    return null;
  }

  const rawStart = normalizedLine.rawIndexByNormalizedIndex[normalizedIndex];
  const rawEnd = normalizedLine.rawIndexByNormalizedIndex[normalizedIndex + normalizedSnippet.length - 1] + 1;
  return { start: rawStart, end: rawEnd };
}

function normalizeWithMap(input: string): NormalizedTextMap {
  let text = "";
  const rawIndexByNormalizedIndex: number[] = [];
  let pendingWhitespace = false;
  let whitespaceIndex = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] === "\u00a0" ? " " : input[index];
    if (/\s/.test(char)) {
      if (text.length > 0) {
        pendingWhitespace = true;
        whitespaceIndex = index;
      }
      continue;
    }

    if (pendingWhitespace) {
      text += " ";
      rawIndexByNormalizedIndex.push(whitespaceIndex);
      pendingWhitespace = false;
    }

    text += char;
    rawIndexByNormalizedIndex.push(index);
  }

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    rawIndexByNormalizedIndex.pop();
  }

  return { text, rawIndexByNormalizedIndex };
}

function looksLikeInlineMath(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (/\\[A-Za-z]+/.test(trimmed)) {
    return true;
  }

  if (/[{}^_=]/.test(trimmed)) {
    return true;
  }

  if (CJK_RE.test(trimmed) && !/[\\^_{}=+\-*/()[\]]/.test(trimmed)) {
    return false;
  }

  if (/[A-Za-z]/.test(trimmed) && /[0-9]/.test(trimmed)) {
    return true;
  }

  if (/^[A-Za-z0-9\s.,+\-*/()]+$/.test(trimmed) && trimmed.length <= 32) {
    return true;
  }

  return false;
}

function sanitizeSnippet(input: string): string {
  return input.replace(/\u00a0/g, " ").replace(/\r/g, "").trim();
}

function stripEdgeEllipsis(input: string): string {
  return input.replace(/^(?:\.{3}|…)\s*/, "").replace(/\s*(?:\.{3}|…)$/, "");
}

function normalizeForComparison(input: string): string {
  return input.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function findClosingInlineDollar(line: string, fromIndex: number): number {
  for (let index = fromIndex; index < line.length; index += 1) {
    if (line[index] === "\\") {
      index += 1;
      continue;
    }

    if (line[index] === "$" && line[index + 1] !== "$") {
      return index;
    }
  }

  return -1;
}

function findClosingDoubleDollar(line: string, fromIndex: number): number {
  for (let index = fromIndex; index < line.length - 1; index += 1) {
    if (line[index] === "\\") {
      index += 1;
      continue;
    }

    if (line[index] === "$" && line[index + 1] === "$") {
      return index;
    }
  }

  return -1;
}

function createSegment(
  type: MathSegmentType,
  text: string,
  lineStarts: number[],
  start: number,
  end: number,
): MathSegment {
  return {
    type,
    start,
    end,
    raw: text.slice(start, end),
    startLine: getLineNumberForOffset(lineStarts, start),
    endLine: getLineNumberForOffset(lineStarts, Math.max(start, end - 1)),
  };
}

function buildLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function getLineRangeFromStarts(text: string, lineStarts: number[], lineNumber: number): TextRange {
  const safeLineNumber = Math.max(1, Math.min(lineNumber, lineStarts.length));
  const start = lineStarts[safeLineNumber - 1];
  let end = safeLineNumber < lineStarts.length ? lineStarts[safeLineNumber] : text.length;

  if (end > start && text[end - 1] === "\n") {
    end -= 1;
  }
  if (end > start && text[end - 1] === "\r") {
    end -= 1;
  }

  return { start, end };
}

function getLineNumberForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return high + 1;
}

function countRepeatedCharacters(input: string, startIndex: number, char: string): number {
  let count = 0;
  while (input[startIndex + count] === char) {
    count += 1;
  }
  return count;
}

function countUnescapedDollars(input: string): number {
  let count = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === "\\" && index + 1 < input.length) {
      index += 1;
      continue;
    }

    if (input[index] === "$") {
      count += 1;
    }
  }
  return count;
}
