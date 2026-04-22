import type { ReaderView } from "../../lib/contracts";

type PdfReaderProps = {
  view: ReaderView;
  page: number;
  zoom: number;
};

export function PdfReader({ view, page, zoom }: PdfReaderProps) {
  return (
    <section className="pdf-reader" data-testid="pdf-reader">
      <div className="reader-location-bar">
        <span className="status-pill">PDF mode</span>
        <span className="meta-count">
          {view.primary_attachment_path ? view.primary_attachment_path.split("/").pop() : "No attachment path"}
        </span>
        <span className="meta-count">Zoom {zoom}%</span>
      </div>
      <div className="citation-card">
        <p className="eyebrow">Native PDF Reader</p>
        <h3>{view.title}</h3>
        <p>
          Page {page + 1}
          {view.page_count ? ` of ${view.page_count}` : ""}
        </p>
        <p>PDF rendering is being initialized for the desktop reader.</p>
      </div>
    </section>
  );
}
