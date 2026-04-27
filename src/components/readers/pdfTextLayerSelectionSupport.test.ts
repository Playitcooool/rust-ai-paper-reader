import { afterEach, describe, expect, it } from "vitest";

import { installPdfJsTextLayerSelectionSupport } from "./pdfTextLayerSelectionSupport";

describe("pdfTextLayerSelectionSupport", () => {
  afterEach(() => {
    // Ensure selections don't leak between tests.
    const selection = document.getSelection?.();
    selection?.removeAllRanges();
  });

  it("appends an endOfContent div on install", () => {
    const host = document.createElement("div");
    host.className = "textLayer";
    const uninstall = installPdfJsTextLayerSelectionSupport(host);

    try {
      expect(host.querySelector(".endOfContent")).toBeTruthy();
    } finally {
      uninstall();
    }
  });

  it("toggles selecting based on selectionchange", () => {
    const host = document.createElement("div");
    host.className = "textLayer";
    const span = document.createElement("span");
    span.setAttribute("role", "presentation");
    span.textContent = "hello world";
    host.appendChild(span);

    const uninstall = installPdfJsTextLayerSelectionSupport(host);
    try {
      document.body.appendChild(host);
      const selection = document.getSelection();
      expect(selection).toBeTruthy();

      const range = document.createRange();
      range.setStart(span.firstChild ?? span, 0);
      range.setEnd(span.firstChild ?? span, 5);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      expect(host.classList.contains("selecting")).toBe(true);

      selection?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
      expect(host.classList.contains("selecting")).toBe(false);
    } finally {
      host.remove();
      uninstall();
    }
  });

  it("falls back when Range.intersectsNode is unavailable/throws", () => {
    const host = document.createElement("div");
    host.className = "textLayer";
    const span = document.createElement("span");
    span.setAttribute("role", "presentation");
    span.textContent = "hello world";
    host.appendChild(span);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (Range.prototype as any).intersectsNode as unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Range.prototype as any).intersectsNode = () => {
      throw new Error("boom");
    };

    const uninstall = installPdfJsTextLayerSelectionSupport(host);
    try {
      document.body.appendChild(host);
      const selection = document.getSelection();
      const range = document.createRange();
      range.setStart(span.firstChild ?? span, 0);
      range.setEnd(span.firstChild ?? span, 5);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      expect(host.classList.contains("selecting")).toBe(true);
    } finally {
      host.remove();
      uninstall();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Range.prototype as any).intersectsNode = original as any;
    }
  });
});
