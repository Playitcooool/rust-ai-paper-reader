import { describe, expect, it } from "vitest";

import { computeFitWidthZoomPct } from "./pdfFit";

describe("computeFitWidthZoomPct", () => {
  it("computes fit-to-width and clamps zoom", () => {
    expect(
      computeFitWidthZoomPct({ containerWidth: 1000, pageWidthAtScale1: 800, marginPx: 0 }),
    ).toBe(125);

    expect(
      computeFitWidthZoomPct({ containerWidth: 200, pageWidthAtScale1: 800, marginPx: 0, minZoomPct: 70 }),
    ).toBe(70);

    expect(
      computeFitWidthZoomPct({ containerWidth: 5000, pageWidthAtScale1: 800, marginPx: 0, maxZoomPct: 180 }),
    ).toBe(180);
  });
});

