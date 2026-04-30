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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const globalOffsetWithinHost = (host: HTMLElement, container: Node, offset: number) => {
  if (!host.contains(container) && host !== container) return null;
  const range = document.createRange();
  range.selectNodeContents(host);
  try {
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  return range.toString().length;
};

const mapGlobalOffsetToDiv = (
  globalOffset: number,
  lengths: number[],
  bias: "start" | "end",
): { divIndex: number; offset: number } | null => {
  if (lengths.length === 0) return null;
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const clamped = clamp(globalOffset, 0, totalLength);

  let cursor = 0;
  for (let divIndex = 0; divIndex < lengths.length; divIndex += 1) {
    const length = lengths[divIndex];
    const start = cursor;
    const end = cursor + length;

    if (bias === "start") {
      if (clamped < end || (length === 0 && clamped === start)) {
        return { divIndex, offset: clamp(clamped - start, 0, length) };
      }
      if (clamped === end && divIndex === lengths.length - 1) {
        return { divIndex, offset: length };
      }
    } else if (clamped <= end) {
      return { divIndex, offset: clamp(clamped - start, 0, length) };
    }

    cursor = end;
  }

  return { divIndex: lengths.length - 1, offset: lengths[lengths.length - 1] };
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
  if ((!host.contains(range.startContainer) && host !== range.startContainer) || (!host.contains(range.endContainer) && host !== range.endContainer)) {
    return null;
  }
  if (divs.length === 0) return null;

  const startGlobal = globalOffsetWithinHost(host, range.startContainer, range.startOffset);
  const endGlobal = globalOffsetWithinHost(host, range.endContainer, range.endOffset);
  if (startGlobal === null || endGlobal === null) return null;

  const lengths = divs.map((div) => div.textContent?.length ?? 0);
  const start = mapGlobalOffsetToDiv(Math.min(startGlobal, endGlobal), lengths, "start");
  const end = mapGlobalOffsetToDiv(Math.max(startGlobal, endGlobal), lengths, "end");
  if (!start || !end) return null;

  const anchor: PdfTextAnchor = {
    type: "pdf_text",
    page: pageNumber1,
    startDivIndex: start.divIndex,
    startOffset: start.offset,
    endDivIndex: end.divIndex,
    endOffset: end.offset,
    quote,
  };
  return { anchor: JSON.stringify(anchor), quote, rect: selectionRectFromRange(range) };
};
