import { describe, expect, it } from "vitest";

import { buildPdfTextSelectionFromRange, parsePdfTextAnchor } from "./pdfSelection";

describe("buildPdfTextSelectionFromRange", () => {
  it("builds a stable pdf_text anchor and includes rect", () => {
    const host = document.createElement("div");
    const div1 = document.createElement("span");
    const div2 = document.createElement("span");
    div1.textContent = "Hello";
    div2.textContent = "World";
    host.append(div1, div2);
    document.body.append(host);

    const range = document.createRange();
    range.setStart(div1.firstChild as Text, 1);
    range.setEnd(div2.firstChild as Text, 3);

    const selection = buildPdfTextSelectionFromRange({
      quote: "elloWor",
      range,
      host,
      divs: [div1, div2],
      pageNumber1: 1,
    });

    expect(selection).not.toBeNull();
    expect(selection?.rect).toEqual(expect.objectContaining({ left: expect.any(Number) }));

    const parsed = selection ? parsePdfTextAnchor(selection.anchor) : null;
    expect(parsed).not.toBeNull();
    expect(parsed?.page).toBe(1);
    expect(parsed?.startDivIndex).toBe(0);
    expect(parsed?.endDivIndex).toBe(1);
    expect(parsed?.startOffset).toBe(1);
    expect(parsed?.endOffset).toBe(3);
  });
});

