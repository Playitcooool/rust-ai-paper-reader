import { cleanup, render, screen } from "@testing-library/react";
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
});
