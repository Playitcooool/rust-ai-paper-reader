import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { createTauriApi, isTauriRuntime } from "./lib/api";
import { installRuntimePolyfills } from "./lib/runtimePolyfills";

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

  await installRuntimePolyfills();
  const api = await createTauriApi();
  root.render(
    <React.StrictMode>
      <App api={api} />
    </React.StrictMode>,
  );
}
