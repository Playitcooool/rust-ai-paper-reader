const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const computeFitWidthZoomPct = (input: {
  containerWidth: number;
  pageWidthAtScale1: number;
  marginPx?: number;
  minZoomPct?: number;
  maxZoomPct?: number;
}) => {
  const {
    containerWidth,
    pageWidthAtScale1,
    marginPx = 40,
    minZoomPct = 70,
    maxZoomPct = 180,
  } = input;

  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 100;
  if (!Number.isFinite(pageWidthAtScale1) || pageWidthAtScale1 <= 0) return 100;

  const usable = Math.max(1, containerWidth - marginPx);
  const scale = usable / pageWidthAtScale1;
  const zoom = scale * 100;
  return Math.round(clamp(zoom, minZoomPct, maxZoomPct));
};

