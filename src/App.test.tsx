import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "./App";
import { resetMockApi } from "./lib/mockApi";

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

    await user.click(await screen.findByRole("button", { name: /Graph Neural Survey/i }));
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
    expect(await screen.findAllByText(/item\.summarize/i)).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: "Current Collection" }));
    await user.click(screen.getByRole("button", { name: "Generate Review Draft" }));

    expect(
      await screen.findByText(/# Machine Learning Review Draft/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Markdown" })).toBeInTheDocument();
  });

  it("imports files into the current collection from the import action", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("button", { name: /Machine Learning/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByRole("button", { name: /Fresh Import Paper/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Imported 2 files into Machine Learning/i)).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: /Dragged Paper/i })).toBeInTheDocument();
    expect(screen.getByText(/Imported 2 files into Machine Learning/i)).toBeInTheDocument();
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
});
