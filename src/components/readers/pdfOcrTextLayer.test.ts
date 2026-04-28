import { describe, expect, it } from "vitest";

import { buildOcrTextLayer } from "./pdfOcrTextLayer";

describe("buildOcrTextLayer", () => {
  it("creates deterministic spans with data-div-index and matching strings", () => {
    const host = document.createElement("div");
    const { divs, strings } = buildOcrTextLayer({
      host,
      viewportWidth: 1000,
      viewportHeight: 2000,
      lines: [
        {
          text: "Hello   world",
          bbox: { left: 0.1, top: 0.2, width: 0.3, height: 0.02 },
          confidence: 88,
        },
        {
          text: "Second line",
          bbox: { left: 0.1, top: 0.25, width: 0.5, height: 0.02 },
          confidence: 77,
        },
      ],
    });

    expect(divs).toHaveLength(2);
    expect(strings).toEqual(["Hello world", "Second line"]);

    const spans = Array.from(host.querySelectorAll('span[role="presentation"]')) as HTMLElement[];
    expect(spans).toHaveLength(2);
    expect(spans[0]?.dataset.divIndex).toBe("0");
    expect(spans[1]?.dataset.divIndex).toBe("1");
    expect(spans[0]?.textContent).toBe("Hello world");
    expect(spans[1]?.textContent).toBe("Second line");
  });
});
