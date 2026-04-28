import { describe, expect, it } from "vitest";

import { getRuntimePolyfillDiagnostics, installRuntimePolyfills } from "./runtimePolyfills";

describe("installRuntimePolyfills", () => {
  it("polyfills Array.prototype.at with correct negative indexing semantics", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (Array.prototype as any).at;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (Array.prototype as any).at;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(([] as any).at).toBeUndefined();

      await installRuntimePolyfills();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(typeof (Array.prototype as any).at).toBe("function");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(([10, 20, 30] as any).at(0)).toBe(10);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(([10, 20, 30] as any).at(-1)).toBe(30);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(([10, 20, 30] as any).at(-3)).toBe(10);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(([10, 20, 30] as any).at(-4)).toBeUndefined();
    } finally {
      // Restore the environment for other tests.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Array.prototype as any).at = original;
    }
  });

  it("installs a minimal ReadableStream polyfill that supports start/enqueue/close + reader.read()", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (globalThis as any).ReadableStream;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).ReadableStream;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((globalThis as any).ReadableStream).toBeUndefined();

      await installRuntimePolyfills();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(typeof (globalThis as any).ReadableStream).toBe("function");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = new (globalThis as any).ReadableStream({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        start(controller: any) {
          controller.enqueue("a");
          controller.enqueue("b");
          controller.close();
        },
      });

      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({ done: false, value: "a" });
      await expect(reader.read()).resolves.toEqual({ done: false, value: "b" });
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      await expect(reader.cancel()).resolves.toBeUndefined();
    } finally {
      // Restore the environment for other tests.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).ReadableStream = original;
    }
  });

  it("overrides an existing but unhealthy ReadableStream implementation", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (globalThis as any).ReadableStream;

    class BadReadableStream {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(source?: any) {
        // Behave like a plausible stream constructor, but `read()` never yields chunks.
        try {
          source?.start?.({ enqueue() {}, close() {} });
        } catch {
          // ignore
        }
      }
      getReader() {
        return {
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => {},
          releaseLock: () => {},
        };
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).ReadableStream = BadReadableStream as any;

      await installRuntimePolyfills();
      const diag = getRuntimePolyfillDiagnostics();
      expect(diag.readableStreamHealthy).toBe(true);
      expect(diag.readableStreamOverridden).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = new (globalThis as any).ReadableStream({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        start(controller: any) {
          controller.enqueue("x");
          controller.close();
        },
      });
      const reader = stream.getReader();
      await expect(reader.read()).resolves.toEqual({ done: false, value: "x" });
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).ReadableStream = original;
    }
  });
});
