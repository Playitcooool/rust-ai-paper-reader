import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { createTauriApi, isTauriRuntime } from "./lib/api";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

function DesktopRuntimeRequired() {
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

async function bootstrap() {
  if (!isTauriRuntime()) {
    root.render(<DesktopRuntimeRequired />);
    return;
  }

  const api = await createTauriApi();
  root.render(
    <React.StrictMode>
      <App api={api} />
    </React.StrictMode>,
  );
}

void bootstrap();
