import { vi } from "vitest";

export const getLegacyDocumentMock = vi.fn();

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: getLegacyDocumentMock,
  TextLayer: class TextLayerMock {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    #container: HTMLElement;
    #textContentSource: unknown;

    constructor({
      textContentSource,
      container,
    }: {
      textContentSource: unknown;
      container: HTMLElement;
      viewport: unknown;
    }) {
      this.#container = container;
      this.#textContentSource = textContentSource;
    }

    async render() {
      const items = (this.#textContentSource as { items?: Array<{ str?: string }> }).items ?? [];
      this.textContentItemsStr = items.map((item) => item.str ?? "");
      this.textDivs = this.textContentItemsStr.map((text) => {
        const span = document.createElement("span");
        span.setAttribute("role", "presentation");
        span.textContent = text;
        this.#container.appendChild(span);
        return span;
      });
    }

    cancel() {}
  },
  AnnotationLayer: class AnnotationLayerMock {
    #div: HTMLDivElement;
    #linkService: { goToDestination?: (dest: unknown) => void };

    constructor({
      div,
      linkService,
    }: {
      div: HTMLDivElement;
      page: unknown;
      viewport: unknown;
      linkService: { goToDestination?: (dest: unknown) => void };
    }) {
      this.#div = div;
      this.#linkService = linkService;
    }

    async render({ annotations }: { annotations: Array<{ dest?: unknown }> }) {
      if (typeof this.#div.replaceChildren === "function") this.#div.replaceChildren();
      else this.#div.innerHTML = "";

      const dest = annotations[0]?.dest;
      if (!dest) return;
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = "Internal link";
      link.setAttribute("data-testid", "internal-link");
      link.onclick = () => {
        this.#linkService.goToDestination?.(dest);
        return false;
      };
      this.#div.appendChild(link);
    }
  },
}));
