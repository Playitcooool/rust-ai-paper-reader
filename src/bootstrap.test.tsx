import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DesktopRuntimeRequired } from "./bootstrap";

describe("DesktopRuntimeRequired", () => {
  it("renders a desktop runtime requirement message outside Tauri", () => {
    render(<DesktopRuntimeRequired />);

    expect(screen.getByLabelText("Desktop runtime required")).toBeInTheDocument();
    expect(screen.getByText(/Paper Reader needs the Tauri desktop runtime/i)).toBeInTheDocument();
    expect(screen.getByText(/npm run tauri:dev/i)).toBeInTheDocument();
  });
});
