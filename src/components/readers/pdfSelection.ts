export type PdfHighlightColor = "yellow" | "red" | "green" | "blue" | "purple";

export type PdfTextAnchor = {
  type: "pdf_text";
  page: number; // 1-based
  startDivIndex: number;
  startOffset: number;
  endDivIndex: number;
  endOffset: number;
  quote: string;
  // Optional, used by PDF Focus highlight bar. Persisted inside anchor JSON for backward compatibility.
  color?: PdfHighlightColor;
};

export type PdfSelectionRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type PdfTextSelection = {
  anchor: string;
  quote: string;
  rect: PdfSelectionRect;
};

export const parsePdfTextAnchor = (anchor: string): PdfTextAnchor | null => {
  try {
    const parsed = JSON.parse(anchor) as Partial<PdfTextAnchor>;
    if (parsed.type !== "pdf_text") return null;
    if (typeof parsed.page !== "number") return null;
    if (typeof parsed.startDivIndex !== "number") return null;
    if (typeof parsed.startOffset !== "number") return null;
    if (typeof parsed.endDivIndex !== "number") return null;
    if (typeof parsed.endOffset !== "number") return null;
    if (typeof parsed.quote !== "string") return null;
    if (parsed.color !== undefined) {
      if (
        parsed.color !== "yellow" &&
        parsed.color !== "red" &&
        parsed.color !== "green" &&
        parsed.color !== "blue" &&
        parsed.color !== "purple"
      ) {
        return null;
      }
    }
    return parsed as PdfTextAnchor;
  } catch {
    return null;
  }
};

const sanitizeClientRectNumber = (value: number) => (Number.isFinite(value) ? value : 0);

export const selectionRectFromRange = (range: Range): PdfSelectionRect => {
  const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  const rect =
    rects.length > 0
      ? rects[rects.length - 1]
      : typeof (range as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect === "function"
        ? (range as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect()
        : ({ left: 0, top: 0, right: 0, bottom: 0 } as const);
  return {
    left: sanitizeClientRectNumber(rect.left),
    top: sanitizeClientRectNumber(rect.top),
    right: sanitizeClientRectNumber(rect.right),
    bottom: sanitizeClientRectNumber(rect.bottom),
  };
};

export const offsetWithinDiv = (div: HTMLElement, container: Node, offset: number) => {
  if (!div.contains(container)) return 0;
  if (container.nodeType === Node.TEXT_NODE) {
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    let length = 0;
    while (node) {
      if (node === container) return length + offset;
      length += (node.nodeValue ?? "").length;
      node = walker.nextNode();
    }
  }
  return offset;
};

export const buildPdfTextSelectionFromRange = (input: {
  quote: string;
  range: Range;
  host: HTMLElement;
  divs: HTMLElement[];
  pageNumber1: number;
}): PdfTextSelection | null => {
  const { quote, range, host, divs, pageNumber1 } = input;
  if (!quote || quote.trim().length === 0) return null;
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
  if (divs.length === 0) return null;

  const startDivIndex = divs.findIndex((div) => div.contains(range.startContainer));
  const endDivIndex = divs.findIndex((div) => div.contains(range.endContainer));
  if (startDivIndex < 0 || endDivIndex < 0) return null;

  const startOffset = offsetWithinDiv(divs[startDivIndex], range.startContainer, range.startOffset);
  const endOffset = offsetWithinDiv(divs[endDivIndex], range.endContainer, range.endOffset);
  const anchor: PdfTextAnchor = {
    type: "pdf_text",
    page: pageNumber1,
    startDivIndex,
    startOffset,
    endDivIndex,
    endOffset,
    quote,
  };
  return { anchor: JSON.stringify(anchor), quote, rect: selectionRectFromRange(range) };
};
