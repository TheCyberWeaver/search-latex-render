import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseMathDocument, recoverSearchExcerpt } from "../src/math-recovery.ts";

const vaultRoot = "C:\\Users\\Thomas\\Documents\\Obsidian\\Main";

test("ignores plain currency markers", () => {
  const source = "- **IPO**时公司以$10每股发行1000万股，募集资金为$1亿。";
  const parsed = parseMathDocument(source);
  assert.equal(parsed.mathSegments.length, 0);
});

test("recovers a full inline formula from a truncated search snippet", () => {
  const source = "For two sets of values,$X = {x_1, x_2, x_3, \\ldots, x_n}$ and $Y = {y_1, y_2}$.";
  const parsed = parseMathDocument(source);
  const result = recoverSearchExcerpt(parsed, {
    lineNumber: 1,
    visibleSnippet: "...x_2, x_3, \\ldots, x_n}$ and...",
    contextChars: 24,
    maxRenderedLineLength: 240,
    maxBlockLength: 2000,
  });

  assert.ok(result);
  assert.equal(result?.recoveredFromFile, true);
  assert.match(result?.excerpt ?? "", /\$X = \{x_1, x_2, x_3, \\ldots, x_n\}\$/);
});

test("recovers a full block formula from the real vault sample", () => {
  const filePath = path.join(vaultRoot, "Finance", "Fiance Basics", "Calculation", "Covariance.md");
  const source = fs.readFileSync(filePath, "utf8");
  const parsed = parseMathDocument(source);

  const result = recoverSearchExcerpt(parsed, {
    lineNumber: 8,
    visibleSnippet: "...\\text{Cov}(X, Y) = \\frac{1}{n}...",
    contextChars: 32,
    maxRenderedLineLength: 240,
    maxBlockLength: 2000,
  });

  assert.ok(result);
  assert.equal(result?.recoveredFromFile, true);
  assert.match(result?.excerpt ?? "", /^\$\$[\s\S]+\$\$$/);
  assert.match(result?.excerpt ?? "", /\\text\{Cov\}\(X, Y\)/);
});

test("does not recover when neither the snippet nor the line carries math", () => {
  const source = "This line contains plain text only.";
  const parsed = parseMathDocument(source);
  const result = recoverSearchExcerpt(parsed, {
    lineNumber: 1,
    visibleSnippet: "plain text only",
    contextChars: 32,
    maxRenderedLineLength: 240,
    maxBlockLength: 2000,
  });

  assert.equal(result, null);
});
