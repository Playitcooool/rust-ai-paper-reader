type NormalizedReaderProps = {
  pageHtml: string;
  zoom: number;
};

export function NormalizedReader({ pageHtml, zoom }: NormalizedReaderProps) {
  return (
    <div
      className="reader-html"
      data-testid="normalized-reader"
      style={{ fontSize: `${zoom}%` }}
      dangerouslySetInnerHTML={{
        __html: pageHtml,
      }}
    />
  );
}
