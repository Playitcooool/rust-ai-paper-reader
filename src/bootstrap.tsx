import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { createTauriApi, isTauriRuntime } from "./lib/api";

function installRuntimePolyfills() {
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
