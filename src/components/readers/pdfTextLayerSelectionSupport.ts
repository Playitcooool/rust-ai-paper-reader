type Uninstall = () => void;

const textLayers = new Map<HTMLElement, HTMLDivElement>();

let listenersInstalled = false;
let isPointerDown = false;
let isFirefox: boolean | undefined;
let prevRange: Range | null = null;

const resetTextLayer = (endDiv: HTMLDivElement, textLayerDiv: HTMLElement) => {
  textLayerDiv.append(endDiv);
  endDiv.style.width = "";
  endDiv.style.height = "";
  endDiv.style.userSelect = "";
  textLayerDiv.classList.remove("selecting");
};

const rangeIntersectsNodeSafely = (range: Range, node: Node) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (range as any).intersectsNode as ((node: Node) => boolean) | undefined;
    if (typeof fn === "function") return fn.call(range, node);
  } catch {
    // Fall through to a contains-based check below.
  }

  // jsdom and some older WebKit builds can be missing/buggy here. This is weaker than
  // the real intersectsNode logic but is good enough to decide which TextLayer is active.
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return false;
  const start = range.startContainer;
  const end = range.endContainer;
  return element.contains(start) || element.contains(end);
};

const installGlobalListenersIfNeeded = () => {
  if (listenersInstalled) return;
  listenersInstalled = true;

  const onPointerDown = () => {
    isPointerDown = true;
  };
  const onPointerUp = () => {
    isPointerDown = false;
    for (const [textLayerDiv, endDiv] of textLayers) resetTextLayer(endDiv, textLayerDiv);
    prevRange = null;
  };
  const onBlur = () => {
    isPointerDown = false;
    for (const [textLayerDiv, endDiv] of textLayers) resetTextLayer(endDiv, textLayerDiv);
    prevRange = null;
  };
  const onKeyUp = () => {
    if (isPointerDown) return;
    for (const [textLayerDiv, endDiv] of textLayers) resetTextLayer(endDiv, textLayerDiv);
    prevRange = null;
  };
  const onSelectionChange = () => {
    const selection = document.getSelection?.();
    if (!selection || selection.rangeCount === 0) {
      for (const [textLayerDiv, endDiv] of textLayers) resetTextLayer(endDiv, textLayerDiv);
      prevRange = null;
      return;
    }

    const activeTextLayers = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      for (const textLayerDiv of textLayers.keys()) {
        if (activeTextLayers.has(textLayerDiv)) continue;
        if (rangeIntersectsNodeSafely(range, textLayerDiv)) activeTextLayers.add(textLayerDiv);
      }
    }

    for (const [textLayerDiv, endDiv] of textLayers) {
      if (activeTextLayers.has(textLayerDiv)) textLayerDiv.classList.add("selecting");
      else resetTextLayer(endDiv, textLayerDiv);
    }

    if (isFirefox === undefined) {
      try {
        const first = textLayers.values().next().value as HTMLDivElement | undefined;
        isFirefox =
          !!first &&
          getComputedStyle(first).getPropertyValue("-moz-user-select") === "none";
      } catch {
        isFirefox = false;
      }
    }
    if (isFirefox) return;

    const range = selection.getRangeAt(0);
    const modifyStart =
      !!prevRange &&
      (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);

    let anchor: Node = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode ?? anchor;

    // Our highlights/search hits add nested spans; don't insert endOfContent inside them.
    const anchorEl = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : null;
    if (
      anchorEl?.classList?.contains("highlight") ||
      anchorEl?.classList?.contains("pdf-annotation-highlight") ||
      anchorEl?.classList?.contains("pdf-search-hit") ||
      anchorEl?.classList?.contains("pdf-search-hit-active")
    ) {
      anchor = anchor.parentNode ?? anchor;
    }

    if (!modifyStart && range.endOffset === 0) {
      do {
        while (anchor.parentNode && !(anchor as ChildNode).previousSibling) {
          anchor = anchor.parentNode;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        anchor = ((anchor as any).previousSibling as Node) ?? anchor;
      } while ((anchor as ParentNode).childNodes && (anchor as ParentNode).childNodes.length === 0);
    }

    const anchorElement =
      anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
    const parentTextLayer = (anchorElement as Element | null)?.closest?.(".textLayer") as
      | HTMLElement
      | null;
    const endDiv = parentTextLayer ? textLayers.get(parentTextLayer) : undefined;
    if (endDiv && parentTextLayer && anchorElement) {
      const rect = parentTextLayer.getBoundingClientRect();
      const width = parentTextLayer.style.width || (Number.isFinite(rect.width) ? `${rect.width}px` : "");
      const height =
        parentTextLayer.style.height || (Number.isFinite(rect.height) ? `${rect.height}px` : "");
      endDiv.style.width = width;
      endDiv.style.height = height;
      endDiv.style.userSelect = "text";

      const candidate = modifyStart ? anchorElement : anchorElement.nextSibling;
      const referenceNode =
        candidate && candidate.parentNode === parentTextLayer ? candidate : null;
      parentTextLayer.insertBefore(endDiv, referenceNode);
    }

    prevRange = range.cloneRange();
  };

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointerup", onPointerUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("selectionchange", onSelectionChange);

  // Store teardown on the module so we can remove listeners when the last layer is unregistered.
  (installGlobalListenersIfNeeded as unknown as { teardown?: Uninstall }).teardown = () => {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
};

const uninstallGlobalListenersIfPossible = () => {
  if (!listenersInstalled) return;
  if (textLayers.size !== 0) return;

  listenersInstalled = false;
  isPointerDown = false;
  isFirefox = undefined;
  prevRange = null;

  const teardown = (installGlobalListenersIfNeeded as unknown as { teardown?: Uninstall }).teardown;
  teardown?.();
  delete (installGlobalListenersIfNeeded as unknown as { teardown?: Uninstall }).teardown;
};

export const installPdfJsTextLayerSelectionSupport = (textLayerDiv: HTMLElement): Uninstall => {
  const existing = textLayers.get(textLayerDiv);
  if (existing) {
    // Idempotent: return an uninstall that only removes one registration.
    return () => {
      // Only uninstall if the mapping still points at the same endDiv.
      if (textLayers.get(textLayerDiv) !== existing) return;
      resetTextLayer(existing, textLayerDiv);
      existing.remove();
      textLayers.delete(textLayerDiv);
      uninstallGlobalListenersIfPossible();
    };
  }

  const endDiv =
    (textLayerDiv.querySelector?.(".endOfContent") as HTMLDivElement | null) ??
    document.createElement("div");
  endDiv.classList.add("endOfContent");
  textLayerDiv.append(endDiv);
  textLayers.set(textLayerDiv, endDiv);
  installGlobalListenersIfNeeded();

  return () => {
    const current = textLayers.get(textLayerDiv);
    if (current !== endDiv) return;
    resetTextLayer(endDiv, textLayerDiv);
    endDiv.remove();
    textLayers.delete(textLayerDiv);
    uninstallGlobalListenersIfPossible();
  };
};
