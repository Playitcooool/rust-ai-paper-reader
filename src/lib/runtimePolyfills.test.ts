import { describe, expect, it } from "vitest";

import { installRuntimePolyfills } from "./runtimePolyfills";

describe("installRuntimePolyfills", () => {
  it("installs a minimal ReadableStream polyfill that supports start/enqueue/close + reader.read()", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (globalThis as any).ReadableStream;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).ReadableStream;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((globalThis as any).ReadableStream).toBeUndefined();

      installRuntimePolyfills();
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
});

