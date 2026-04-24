import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./components/readers/PdfReader", () => {
  function MockPdfReader({
    view,
    page,
    onPageCountChange,
  }: {
    view: {
      title: string;
      page_count: number | null;
    };
    page: number;
    onPageCountChange?: (pageCount: number) => void;
  }) {
    useEffect(() => {
      onPageCountChange?.(view.page_count ?? 1);
    }, [onPageCountChange, view.page_count]);

    return (
      <section data-testid="pdf-reader">
        <h3>{view.title}</h3>
        <p>Mock PDF reader page {page + 1}</p>
      </section>
    );
  }

  return { PdfReader: MockPdfReader };
});

import App from "./App";
import { fakeApi, replaceFakeApiState, resetFakeApi } from "./test/fakeApi";

beforeEach(() => {
  resetFakeApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App reading workspace", () => {
  it("renders a resource tree instead of the current collection card list", async () => {
    render(<App api={fakeApi} />);

    expect(await screen.findByRole("tree", { name: "Library resources" })).toBeInTheDocument();
    expect(screen.queryByText("Current Collection")).not.toBeInTheDocument();
    expect(screen.queryByText("paper-card")).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Machine Learning/i })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /Transformer Scaling Laws/i })).toBeInTheDocument();
  });

  it("single-click opens a global tab and double-clicking a pdf enters focus mode", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    const pdfNode = await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i });
    await user.click(pdfNode);

    expect(screen.getByRole("tab", { name: "Transformer Scaling Laws" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to workspace" })).not.toBeInTheDocument();

    await user.dblClick(pdfNode);

    expect(await screen.findByRole("button", { name: "Back to workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
    expect(screen.getByTestId("pdf-reader")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open AI Workspace" })).not.toBeInTheDocument();
  });

  it("leaves pdf focus when switching to a non-pdf tab", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    const pdfNode = await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i });
    const docxNode = screen.getByRole("treeitem", { name: /Graph Neural Survey/i });

    await user.click(docxNode);
    expect(screen.getByRole("tab", { name: "Graph Neural Survey" })).toBeInTheDocument();

    await user.dblClick(pdfNode);
    expect(await screen.findByRole("button", { name: "Back to workspace" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Graph Neural Survey" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Back to workspace" })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("normalized-reader")).toBeInTheDocument();
  });

  it("escape exits pdf focus but only when the current target is not an editor", async () => {
    const user = userEvent.setup();

    render(<App api={fakeApi} />);

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    expect(await screen.findByRole("button", { name: "Back to workspace" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Back to workspace" })).not.toBeInTheDocument();
    });

    await user.dblClick(await screen.findByRole("treeitem", { name: /Transformer Scaling Laws/i }));
    const searchInput = screen.getByRole("textbox", { name: "Find in document" });
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Back to workspace" })).toBeInTheDocument();
  });

  it("gates pdf text tools for partial and unavailable content while keeping page rendering", async () => {
    replaceFakeApiState({
      items: [
        {
          id: 1,
          title: "Scanned PDF",
          collection_id: 1,
          primary_attachment_id: 101,
          attachment_status: "ready",
          authors: "Reader Team",
          publication_year: 2026,
          source: "Paper Reader",
          doi: null,
          tags: [],
          plainText: "",
          normalizedHtml: "<article><p>Fallback content.</p></article>",
          attachmentFormat: "pdf",
          primaryAttachmentPath: "/mock/scanned.pdf",
          pageCount: 2,
          contentStatus: "partial",
          contentNotice: "This PDF can be read by page, but only part of the text layer is reliable.",
        } as never,
      ],
    });

    const user = userEvent.setup();
    render(<App api={fakeApi} />);

    await user.dblClick(await screen.findByRole("treeitem", { name: /Scanned PDF/i }));

    expect(await screen.findByTestId("pdf-reader")).toBeInTheDocument();
    expect(screen.getByText(/only part of the text layer is reliable/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Find in document" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open AI Workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Highlight" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Reader Content/i)).not.toBeInTheDocument();
  });
});
