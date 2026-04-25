export const clearChildren = (element: Element) => {
  const maybeReplace = (element as unknown as { replaceChildren?: () => void }).replaceChildren;
  if (typeof maybeReplace === "function") {
    maybeReplace.call(element);
    return;
  }

  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
};

export const safeScrollIntoView = (element: Element, options?: ScrollIntoViewOptions) => {
  const fn = (element as unknown as { scrollIntoView?: (arg?: unknown) => void }).scrollIntoView;
  if (typeof fn !== "function") return;

  try {
    fn.call(element, options);
  } catch {
    try {
      fn.call(element);
    } catch {
      // Ignore scroll failures in older runtimes.
    }
  }
};

