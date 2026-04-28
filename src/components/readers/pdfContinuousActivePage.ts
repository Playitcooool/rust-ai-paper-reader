export type VerticalRect = {
  top: number;
  bottom: number;
};

export type ActivePageRect = VerticalRect & {
  pageIndex0: number;
};

export function computeActivePageIndexFromRects(input: {
  rootRect: VerticalRect;
  pageRects: ActivePageRect[];
  anchorRatio?: number;
}): number | null {
  const { rootRect, pageRects } = input;
  if (!Number.isFinite(rootRect.top) || !Number.isFinite(rootRect.bottom) || pageRects.length === 0) return null;

  const rootHeight = rootRect.bottom - rootRect.top;
  if (!Number.isFinite(rootHeight) || rootHeight <= 0) return null;

  const anchorRatio = Math.max(0, Math.min(1, input.anchorRatio ?? 0.38));
  const anchorY = rootRect.top + rootHeight * anchorRatio;

  let best: { pageIndex0: number; distance: number; centerDistance: number } | null = null;

  for (const rect of pageRects) {
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.bottom <= rect.top) continue;

    const distance =
      anchorY < rect.top ? rect.top - anchorY : anchorY > rect.bottom ? anchorY - rect.bottom : 0;
    const centerDistance = Math.abs(anchorY - (rect.top + rect.bottom) / 2);

    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && centerDistance < best.centerDistance) ||
      (distance === best.distance && centerDistance === best.centerDistance && rect.pageIndex0 < best.pageIndex0)
    ) {
      best = {
        pageIndex0: rect.pageIndex0,
        distance,
        centerDistance,
      };
    }
  }

  return best?.pageIndex0 ?? null;
}
