import type { OcrLine } from "../../lib/contracts";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function buildOcrTextLayer(input: {
  host: HTMLElement;
  viewportWidth: number;
  viewportHeight: number;
  lines: OcrLine[];
}): { divs: HTMLElement[]; strings: string[] } {
  const { host, viewportWidth, viewportHeight, lines } = input;

  const divs: HTMLElement[] = [];
  const strings: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = (line.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const left = clamp01(line.bbox.left) * viewportWidth;
    const top = clamp01(line.bbox.top) * viewportHeight;
    const width = clamp01(line.bbox.width) * viewportWidth;
    const height = clamp01(line.bbox.height) * viewportHeight;

    const span = document.createElement("span");
    span.setAttribute("role", "presentation");
    span.dataset.divIndex = String(divs.length);
    span.textContent = text;
    span.style.left = `${left}px`;
    span.style.top = `${top}px`;

    // Keep selection reasonably aligned; we don't care about visual appearance (text is transparent).
    span.style.fontSize = `${Math.max(1, height)}px`;
    span.style.lineHeight = "1";
    span.style.display = "inline-block";
    span.style.transformOrigin = "0 0";
    span.style.transform = "none";

    host.appendChild(span);

    // pdf.js' TextLayer uses horizontal scaling to better match the underlying glyph boxes.
    // We do the same so selection/copy feels more natural.
    const naturalWidth = span.getBoundingClientRect().width;
    if (Number.isFinite(width) && width > 0 && Number.isFinite(naturalWidth) && naturalWidth > 0.5) {
      const scaleX = Math.max(0.01, width / naturalWidth);
      span.style.transform = `scaleX(${scaleX})`;
    }

    // Keep the element box close to the OCR bbox to improve hit testing and highlight overlays.
    if (Number.isFinite(width) && width > 0) span.style.width = `${width}px`;
    if (Number.isFinite(height) && height > 0) span.style.height = `${height}px`;

    divs.push(span);
    strings.push(text);
  }

  return { divs, strings };
}
