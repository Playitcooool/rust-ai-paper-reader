import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "./App";
import { replaceMockApiState, resetMockApi } from "./lib/mockApi";

beforeEach(() => {
  resetMockApi();
});

afterEach(() => {
  cleanup();
});

describe("App workspace", () => {
  it("renders the three-pane workspace and lets the user switch tabs", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Collections", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Current Paper" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Current Collection" })).toBeInTheDocument();
    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", { name: /Graph Neural Survey/i }),
    );
    expect(
      screen.getByRole("heading", { name: "Graph Neural Survey", level: 2 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    expect(screen.getByText("Generate Review Draft")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Machine Learning", level: 3 }),
    ).toBeInTheDocument();
  });

  it("loads data from the api layer and updates research output when an AI action runs", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Summarize document" }));
    expect((await screen.findAllByText(/item\.summarize/i)).length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));

    expect(
      await screen.findByText(/# Review Draft: Machine Learning/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Markdown" })).toBeInTheDocument();
  });

  it("imports files into the current collection from the import action", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByRole("tab", { name: "Fresh Import Paper" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Imported 2 files into Machine Learning/i)).toBeInTheDocument();
  });

  it("shows a true empty-library workspace when no collections exist", async () => {
    replaceMockApiState({
      collections: [],
      items: [],
      tags: [],
      itemTags: [],
      annotations: [],
      tasks: [],
      artifacts: [],
      notes: [],
    });

    render(<App />);

    expect(await screen.findByText(/Start with a collection/i)).toBeInTheDocument();
    expect(screen.getByText(/Create a root collection on the left/i)).toBeInTheDocument();
    expect(screen.getByText(/No collection selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Create your first collection to start building the desktop library/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Import Citations" })).toBeDisabled();
  });

  it("imports dropped files into the active collection", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    const dropZone = screen.getByLabelText("Collection drop zone");
    const files = [
      new File(["pdf"], "dragged-paper.pdf", { type: "application/pdf" }),
      new File(["epub"], "lab-notes.epub", { type: "application/epub+zip" }),
    ];
    const dataTransfer = {
      files,
      types: ["Files"],
    };

    fireEvent.dragEnter(dropZone, { dataTransfer });
    expect(screen.getByText(/Drop 2 files into Machine Learning/i)).toBeInTheDocument();

    fireEvent.drop(dropZone, { dataTransfer });

    expect(await screen.findByRole("tab", { name: "Dragged Paper" })).toBeInTheDocument();
    expect(screen.getByText(/Imported 2 files into Machine Learning/i)).toBeInTheDocument();
  });

  it("removes the active paper from the library and closes its reader tab", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove from Library" }));

    expect(await screen.findByText(/Removed Transformer Scaling Laws from the library/i)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Transformer Scaling Laws" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Graph Neural Survey", level: 2 })).toBeInTheDocument();
  });

  it("moves the active paper into another collection", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Move paper destination"), "2");
    await user.click(screen.getByRole("button", { name: "Move Paper" }));

    expect(await screen.findByText(/Moved Transformer Scaling Laws to Systems/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Transformer Scaling Laws", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Systems · ready · PDF/i)).toBeInTheDocument();
  });

  it("lets the reader jump between outline sections", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const methodsButton = screen.getByRole("button", { name: "Methods" });
    await user.click(methodsButton);

    expect(methodsButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Focused reader outline on Methods/i)).toBeInTheDocument();
  });

  it("sorts the visible papers by newest year in the current collection", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Sort papers"), "year_desc");

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    const paperButtons = within(collectionPanel).getAllByRole("button");
    expect(paperButtons[0]).toHaveTextContent("Graph Neural Survey");
    expect(paperButtons[1]).toHaveTextContent("Transformer Scaling Laws");
  });

  it("filters the visible papers by attachment state", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Systems/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Systems/i }));
    await user.selectOptions(screen.getByLabelText("Attachment filter"), "missing");
    await user.click(screen.getByRole("tab", { name: "Current Collection" }));

    expect(
      await screen.findByRole("heading", { name: "Distributed Consensus Notes", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Filtered by attachment: missing/i)).toBeInTheDocument();
    expect(screen.getByText(/1 papers included/i)).toBeInTheDocument();
  });

  it("jumps back to an annotation anchor from the reader chips", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const annotationJump = screen.getByRole("button", {
      name: /Jump to annotation section-1/i,
    });
    await user.click(annotationJump);

    expect(screen.getByText(/Jumped to annotation section-1/i)).toBeInTheDocument();
    expect(screen.getByText(/Active anchor: section-1/i)).toBeInTheDocument();
  });

  it("jumps from AI source references back into the reader anchor", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const sourceButton = screen.getByRole("button", { name: /Source: section-1/i });
    await user.click(sourceButton);

    expect(screen.getByText(/Jumped to annotation section-1/i)).toBeInTheDocument();
    expect(screen.getByText(/Active anchor: section-1/i)).toBeInTheDocument();
  });

  it("shows paper task history and reruns a paper task from history", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Translate selection" }));
    expect(await screen.findByText(/Completed item\.translate for Transformer Scaling Laws\./i)).toBeInTheDocument();

    expect(screen.getByText(/Paper Task History/i)).toBeInTheDocument();
    expect(screen.getAllByText(/item\.translate/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Run Again item\.summarize/i }));

    expect(await screen.findByText(/Completed item\.summarize for Transformer Scaling Laws\./i)).toBeInTheDocument();
    expect(screen.getAllByText(/item\.summarize/i).length).toBeGreaterThan(1);
  });

  it("renders task-specific paper outputs", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Translate selection" }));
    expect(await screen.findByText(/# Translation: Transformer Scaling Laws/i)).toBeInTheDocument();
    expect(screen.getByText(/## Translated Passage/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Explain terminology" }));
    expect(await screen.findByText(/# Terminology Notes: Transformer Scaling Laws/i)).toBeInTheDocument();
    expect(screen.getByText(/## Key Terms/i)).toBeInTheDocument();
  });

  it("creates and updates a research note from the collection workspace", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));
    await user.click(screen.getByRole("button", { name: "Save as Research Note" }));

    const editor = await screen.findByLabelText("Research note editor");
    await user.clear(editor);
    await user.type(editor, "# Updated Review Note");
    await user.click(screen.getByRole("button", { name: "Save Note Edits" }));

    expect(screen.getByDisplayValue("# Updated Review Note")).toBeInTheDocument();
    expect(screen.getByText(/Saved note edits for Machine Learning/i)).toBeInTheDocument();
  });

  it("lists research notes, switches the active note, and exports the selected note", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));
    await user.click(screen.getByRole("button", { name: "Save as Research Note" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));
    await user.click(screen.getByRole("button", { name: "Save as Research Note" }));

    expect(screen.getByText(/Research Notes/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Open research note/i }).length).toBeGreaterThan(1);

    await user.click(screen.getAllByRole("button", { name: /Open research note .*Review Draft: Machine Learning/i })[0]);
    expect(await screen.findByDisplayValue(/# Review Draft: Machine Learning/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(await screen.findByText(/Exported Markdown for # Review Draft: Machine Learning/i)).toBeInTheDocument();
  });

  it("shows collection review scope and included papers in the AI workspace", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));

    expect(screen.getByText(/Review Scope/i)).toBeInTheDocument();
    expect(screen.getByText(/2 papers included/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Transformer Scaling Laws/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Graph Neural Survey/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Filter tag Scaling" }));
    await user.click(screen.getByRole("tab", { name: "Current Collection" }));

    expect(screen.getByText(/Filtered by tag: Scaling/i)).toBeInTheDocument();
    expect(screen.getByText(/1 papers included/i)).toBeInTheDocument();
  });

  it("shows the latest collection task kind in the workspace after running it", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));

    expect(await screen.findByText(/Latest Run/i)).toBeInTheDocument();
    expect(screen.getAllByText(/collection\.theme_map/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Machine Learning/i).length).toBeGreaterThan(0);
  });

  it("renders task-specific collection outputs and history previews", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));

    expect(await screen.findByText(/# Theme Map: Machine Learning/i)).toBeInTheDocument();
    expect(screen.getByText(/## Themes/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Compare Methods" }));

    expect(await screen.findByText(/# Method Comparison: Machine Learning/i)).toBeInTheDocument();
    expect(screen.getByText(/## Comparison Matrix/i)).toBeInTheDocument();
    expect(screen.getByText(/Theme clusters across 2 visible papers\./i)).toBeInTheDocument();
    expect(screen.getAllByText(/Method comparison across 2 visible papers\./i).length).toBeGreaterThan(0);
  });

  it("reruns a collection task from task history", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Theme Map" }));
    await user.click(await screen.findByRole("button", { name: /Run Again collection\.theme_map/i }));

    expect(await screen.findByText(/Completed collection\.theme_map for Machine Learning/i)).toBeInTheDocument();
    expect(screen.getAllByText(/collection\.theme_map/i).length).toBeGreaterThan(1);
  });

  it("creates a new collection from the sidebar", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("New collection name"), "Reading Queue");
    await user.click(screen.getByRole("button", { name: "Add Collection" }));

    expect(await screen.findByRole("button", { name: /Reading Queue/i })).toBeInTheDocument();
    expect(screen.getByText(/Created collection Reading Queue/i)).toBeInTheDocument();
  });

  it("creates a nested collection under the current collection", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText("New collection name"), "Theory");
    await user.click(screen.getByRole("button", { name: "Add Nested Collection" }));

    expect(
      await screen.findByRole("button", { name: /Open collection Machine Learning \/ Theory/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Created nested collection Theory under Machine Learning/i)).toBeInTheDocument();
  });

  it("moves the selected collection under a new parent", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Systems/i }));
    await user.selectOptions(screen.getByLabelText("Move collection destination"), "1");
    await user.click(screen.getByRole("button", { name: "Move Collection" }));

    expect(
      await screen.findByRole("button", { name: /Open collection Machine Learning \/ Systems/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Moved Systems into Machine Learning/i)).toBeInTheDocument();
  });

  it("filters the current collection by tag from the sidebar", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter tag Scaling" }));

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    expect(
      within(collectionPanel).getByRole("button", { name: /Transformer Scaling Laws/i }),
    ).toBeInTheDocument();
    expect(
      within(collectionPanel).queryByRole("button", { name: /Graph Neural Survey/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^All Tags/ }));

    expect(
      within(collectionPanel).getByRole("button", { name: /Graph Neural Survey/i }),
    ).toBeInTheDocument();
  });

  it("creates a tag and assigns it to the current paper", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("New tag name"), "Foundations");
    await user.click(screen.getByRole("button", { name: "Add Tag to Current Paper" }));

    expect(await screen.findByRole("button", { name: "Filter tag Foundations" })).toBeInTheDocument();
    expect(screen.getByText(/Tagged Transformer Scaling Laws with Foundations/i)).toBeInTheDocument();
  });

  it("shows the latest formatted citation in the reader panel", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy Citation" }));

    expect(await screen.findByText(/Latest Citation/i)).toBeInTheDocument();
    expect(screen.getByText(/APA 7 · Kaplan et al\./i)).toBeInTheDocument();
  });

  it("shows author and year metadata in the reader panel and supports author search", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    expect(screen.getAllByText(/Kaplan et al\./i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/2020 · OpenAI/i).length).toBeGreaterThanOrEqual(2);

    await user.clear(screen.getByLabelText("Search papers"));
    await user.type(screen.getByLabelText("Search papers"), "Kaplan");

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    expect(
      await within(collectionPanel).findByRole("button", { name: /Transformer Scaling Laws/i }),
    ).toBeInTheDocument();
    expect(
      within(collectionPanel).queryByRole("button", { name: /Graph Neural Survey/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an expanded metadata panel for the active paper", async () => {
    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    expect(screen.getByText(/Document Metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/^Authors$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Kaplan et al\.$/i)).toBeInTheDocument();
    expect(screen.getByText(/^DOI$/i)).toBeInTheDocument();
    expect(screen.getByText(/10\.1000\/scaling-laws/i)).toBeInTheDocument();
    expect(screen.getByText(/^Attachment$/i)).toBeInTheDocument();
    expect(screen.getByText(/^ready · PDF$/i)).toBeInTheDocument();
  });

  it("edits metadata for the active paper from the reader panel", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit Metadata" }));
    await user.clear(screen.getByLabelText("Metadata title"));
    await user.type(screen.getByLabelText("Metadata title"), "Edited Scaling Laws");
    await user.clear(screen.getByLabelText("Metadata authors"));
    await user.type(screen.getByLabelText("Metadata authors"), "OpenAI Research");
    await user.clear(screen.getByLabelText("Metadata year"));
    await user.type(screen.getByLabelText("Metadata year"), "2024");
    await user.clear(screen.getByLabelText("Metadata source"));
    await user.type(screen.getByLabelText("Metadata source"), "NeurIPS");
    await user.clear(screen.getByLabelText("Metadata DOI"));
    await user.type(screen.getByLabelText("Metadata DOI"), "10.1000/edited-scaling");
    await user.click(screen.getByRole("button", { name: "Save Metadata" }));

    expect(await screen.findByRole("heading", { name: "Edited Scaling Laws", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText(/OpenAI Research · 2024 · NeurIPS/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/10\.1000\/edited-scaling/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Edited Scaling Laws/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Saved metadata for Edited Scaling Laws/i)).toBeInTheDocument();
  });

  it("exports BibTeX and RIS citations for the active paper", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export BibTeX" }));
    expect(await screen.findByText(/@article\{/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export RIS" }));
    expect(await screen.findByText(/TY\s*-\s*JOUR/i)).toBeInTheDocument();
  });

  it("imports citation records into the current collection", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import Citations" }));

    expect(await screen.findByRole("tab", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(screen.getByText(/Imported 2 citation records into Machine Learning/i)).toBeInTheDocument();
  });

  it("shows a relink guidance state for missing attachments", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Systems/i }));
    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", {
        name: /Distributed Consensus Notes/i,
      }),
    );

    expect(screen.getByText(/Source file missing/i)).toBeInTheDocument();
    expect(screen.getByText(/Relink this attachment to restore reading and AI actions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Relink Source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeDisabled();
  });

  it("shows a metadata-only state for citation imports", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import Citations" }));
    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", { name: /Attention Is All You Need/i }),
    );

    expect(screen.getByText(/Metadata-only entry/i)).toBeInTheDocument();
    expect(screen.getByText(/Import a PDF, DOCX, or EPUB later to enable full reading and AI extraction/i)).toBeInTheDocument();
    expect(screen.getByText(/Citation metadata is available for export and organization right now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeDisabled();
  });

  it("relinks a missing linked attachment from the reader actions", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Systems/i }));
    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      await within(collectionPanel).findByRole("button", {
        name: /Distributed Consensus Notes/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Relink Source" }));

    expect(await screen.findByText(/Relinked source for Distributed Consensus Notes/i)).toBeInTheDocument();
    expect(screen.getByText(/Systems · ready · EPUB/i)).toBeInTheDocument();
  });

  it("closes reader tabs and keeps the workspace stable", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    const collectionPanel = screen.getByRole("region", { name: "Collection drop zone" });
    await user.click(
      within(collectionPanel).getByRole("button", { name: /Graph Neural Survey/i }),
    );
    expect(await screen.findByRole("tab", { name: "Graph Neural Survey" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close tab Graph Neural Survey" }));
    expect(screen.queryByRole("tab", { name: "Graph Neural Survey" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close tab Transformer Scaling Laws" }));
    expect(screen.queryByRole("tab", { name: "Transformer Scaling Laws" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No paper selected", level: 2 })).toBeInTheDocument();
  });

  it("clears stale reader context when switching to an empty collection", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("tab", { name: "Transformer Scaling Laws" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("New collection name"), "Inbox");
    await user.click(screen.getByRole("button", { name: "Add Collection" }));

    expect(screen.getByRole("heading", { name: "No paper selected", level: 2 })).toBeInTheDocument();
    expect(await screen.findAllByText("Open a paper to see its extracted text.")).toHaveLength(2);
    expect(screen.getByText(/No papers in this collection yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Import PDF, DOCX, EPUB, or citation files to start this workspace/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarize document" })).toBeDisabled();
  });
});
