import "bootstrap/dist/css/bootstrap.min.css";
import "./styles/theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";

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
      <App />
    </BrowserRouter>
  </StrictMode>,
);
