import type { PdfPageBundle } from "../../lib/contracts";

type BuiltPdfTextLayer = {
  divs: HTMLElement[];
  strings: string[];
};

const PT_TO_CSS_PX = 96 / 72;

export const pageWidthAtScale1FromPoints = (pageWidthPt: number) => pageWidthPt * PT_TO_CSS_PX;

export function buildRustPdfTextLayer(input: {
  host: HTMLElement;
  bundle: PdfPageBundle;
  renderedWidthCssPx: number;
  renderedHeightCssPx: number;
}): BuiltPdfTextLayer {
  const { host, bundle, renderedWidthCssPx, renderedHeightCssPx } = input;
  host.replaceChildren();

  const divs: HTMLElement[] = [];
  const strings: string[] = [];

  const pageWidthPt = Math.max(1, bundle.page_width_pt);
  const pageHeightPt = Math.max(1, bundle.page_height_pt);
  const scaleX = renderedWidthCssPx / pageWidthPt;
  const scaleY = renderedHeightCssPx / pageHeightPt;

  for (const span of bundle.spans) {
    const text = span.text ?? "";
    if (text.length === 0) continue;

    const left = Math.max(0, span.x0 * scaleX);
    const top = Math.max(0, (pageHeightPt - span.y1) * scaleY);
    const width = Math.max(1, (span.x1 - span.x0) * scaleX);
    const height = Math.max(1, (span.y1 - span.y0) * scaleY);

    const node = document.createElement("span");
    node.setAttribute("role", "presentation");
    node.dataset.divIndex = String(divs.length);
    node.textContent = text;
    node.style.position = "absolute";
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    node.style.whiteSpace = "pre";
    node.style.transform = "none";
    node.style.fontSize = `${Math.max(8, height)}px`;
    node.style.lineHeight = "1";
    node.style.color = "transparent";
    node.style.webkitTextFillColor = "transparent";
    node.style.cursor = "text";
    node.style.userSelect = "text";
    node.style.webkitUserSelect = "text";
    host.appendChild(node);

    divs.push(node);
    strings.push(text);
  }

  const end = document.createElement("div");
  end.className = "endOfContent";
  host.appendChild(end);

  return { divs, strings };
}
