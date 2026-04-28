import { describe, expect, it } from "vitest";

import { computeActivePageIndexFromRects } from "./pdfContinuousActivePage";

describe("computeActivePageIndexFromRects", () => {
  it("picks the page containing the viewport anchor", () => {
    expect(
      computeActivePageIndexFromRects({
        rootRect: { top: 0, bottom: 1000 },
        pageRects: [
          { pageIndex0: 0, top: 0, bottom: 600 },
          { pageIndex0: 1, top: 620, bottom: 1220 },
        ],
        anchorRatio: 0.38,
      }),
    ).toBe(0);
  });

  it("tracks tall pages while scrolling within the same page", () => {
    expect(
      computeActivePageIndexFromRects({
        rootRect: { top: 0, bottom: 1000 },
        pageRects: [
          { pageIndex0: 0, top: -900, bottom: 1500 },
          { pageIndex0: 1, top: 1520, bottom: 2320 },
        ],
        anchorRatio: 0.38,
      }),
    ).toBe(0);
  });

  it("falls back to the nearest page when the anchor is between pages", () => {
    expect(
      computeActivePageIndexFromRects({
        rootRect: { top: 0, bottom: 1000 },
        pageRects: [
          { pageIndex0: 0, top: -900, bottom: 250 },
          { pageIndex0: 1, top: 700, bottom: 1700 },
        ],
        anchorRatio: 0.38,
      }),
    ).toBe(0);
  });
});
