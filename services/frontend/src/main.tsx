import "bootstrap/dist/css/bootstrap.min.css";
import "./styles/theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorFallback, ErrorBoundary } from "./components/ErrorBoundary";

// The mouse's side "back/forward" buttons default to history.back()/forward(), navigating the
// SPA's BrowserRouter out from under the UI. Blocked app-wide, for the app's lifetime.
window.addEventListener(
  "mouseup",
  (event) => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
    }
  },
  { capture: true },
);
window.addEventListener(
  "auxclick",
  (event) => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
    }
  },
  { capture: true },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      {/* Outside every provider on purpose: its fallback replaces the whole screen, so it needs
          none of them, and staying outside is the only way to also catch a throw in a provider's
          own body (App.tsx's ToastProvider..DockerStatusProvider stack) or its sibling modals. */}
      <ErrorBoundary fallback={AppErrorFallback}>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
