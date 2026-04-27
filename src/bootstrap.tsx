import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { createTauriApi, isTauriRuntime } from "./lib/api";

function installRuntimePolyfills() {
  // pdf.js AnnotationLayer uses Element.prototype.replaceChildren.
  if (
    typeof Element !== "undefined" &&
    typeof (Element.prototype as unknown as { replaceChildren?: unknown }).replaceChildren !== "function"
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).replaceChildren = function replaceChildrenPolyfill(this: Element, ...nodes: Node[]) {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (const node of nodes) this.appendChild(node);
    };
  }

  // pdfjs-dist 5.x uses URL.parse in some code paths; older WKWebView builds don't have it.
  if (typeof URL !== "undefined" && typeof (URL as unknown as { parse?: unknown }).parse !== "function") {
    (URL as unknown as { parse: (input: string, base?: string) => URL | null }).parse = (
      input: string,
      base?: string,
    ) => {
      try {
        return base ? new URL(input, base) : new URL(input);
      } catch {
        return null;
      }
    };
  }

  // Some older WebKit builds still miss Promise.allSettled.
  if (typeof Promise !== "undefined" && typeof Promise.allSettled !== "function") {
    Promise.allSettled = ((promises: Iterable<unknown>) =>
      Promise.all(
        Array.from(promises).map(promise =>
          Promise.resolve(promise).then(
            value => ({ status: "fulfilled", value }) as const,
            reason => ({ status: "rejected", reason }) as const,
          ),
        ),
      )) as typeof Promise.allSettled;
  }

  // pdfjs-dist 5.x TextLayer uses Promise.withResolvers; older WebKit/Tauri builds may miss it.
  if (typeof Promise !== "undefined" && typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== "function") {
    (Promise as unknown as { withResolvers: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } }).withResolvers =
      <T,>() => {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      };
  }

  // Some pdf.js text-layer paths expect ReadableStream to exist even when the document is loaded from bytes.
  // Provide a tiny stub for older WebKit builds so TextLayer doesn't fail hard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).ReadableStream !== "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ReadableStream = class ReadableStreamPolyfill {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(_source?: any) {}
      getReader() {
        return {
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => {},
        };
      }
      cancel() {
        return Promise.resolve();
      }
    };
  }
}

export function DesktopRuntimeRequired() {
  return (
    <React.StrictMode>
      <main className="app-shell" role="main">
        <section className="empty-state" aria-label="Desktop runtime required">
          <p className="eyebrow">Desktop Runtime Required</p>
          <h1>Paper Reader needs the Tauri desktop runtime.</h1>
          <p>Run this app with `npm run tauri:dev` or a packaged desktop build to open your local library.</p>
        </section>
      </main>
    </React.StrictMode>
  );
}

export async function bootstrap(rootElement: HTMLElement) {
  const root = ReactDOM.createRoot(rootElement);

  if (!isTauriRuntime()) {
    root.render(<DesktopRuntimeRequired />);
    return;
  }

  installRuntimePolyfills();
  const api = await createTauriApi();
  root.render(
    <React.StrictMode>
      <App api={api} />
    </React.StrictMode>,
  );
}
