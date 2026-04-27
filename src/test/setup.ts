import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Readers may call the Tauri shell plugin to open external links.
// In unit tests we stub it out and assert calls where needed.
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => undefined),
}));
