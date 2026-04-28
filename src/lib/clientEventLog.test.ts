import { describe, expect, it } from "vitest";

import { textForLog } from "./clientEventLog";

describe("clientEventLog", () => {
  it("normalizes whitespace and truncates snippets to 120 chars", () => {
    const input = "  hello \n\t world   ".repeat(20);
    const normalized = textForLog(input)?.text_snippet ?? "";
    expect(normalized).toBe(normalized.trim());
    expect(/\s{2,}/.test(normalized)).toBe(false);
    expect(normalized.length).toBeLessThanOrEqual(120);
  });

  it("produces text_len and a snippet", () => {
    const out = textForLog("  a  b \n c  ");
    expect(out?.text_len).toBe("a  b \n c".trim().length);
    expect(out?.text_snippet).toBe("a b c");
  });
});
