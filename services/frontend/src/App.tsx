import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppNavbar } from "./components/AppNavbar";
import { ConfirmProvider } from "./context/ConfirmContext";
import { isDesktop } from "./desktop/bridge";
import { DesktopCommandsProvider } from "./desktop/DesktopCommands";
import { ElevationProvider } from "./desktop/ElevationContext";
import { TitleBar } from "./desktop/TitleBar";
import { PromptProvider } from "./context/PromptContext";
import { ToastProvider } from "./context/ToastContext";
import { SettingsPage } from "./pages/SettingsPage";
import { TerminalWindowPage } from "./pages/TerminalWindowPage";
import { WorkspacePage } from "./pages/WorkspacePage";

// In the Electron shell the top bar *is* the window's title bar (no native one), so the same
// content is rendered by TitleBar instead of AppNavbar — one strip, not two stacked bars.
function TopBar() {
  return isDesktop() ? <TitleBar /> : <AppNavbar />;
}

// Normal scrolling shell (top bar + padded main), used by Settings.
function AppLayout() {
  return (
    <>
      <TopBar />
      {/* pb-5: without it, page content stops dead at the last element with no bottom
          breathing room — applied once here instead of on every page. */}
      <main className="pb-5">
        <Outlet />
      </main>
    </>
  );
}

// Full-height shell for the Workspace: same top bar, but a viewport-filling main (no scrolling
// body / no pb-5) so the page can lay out its own rail + dock like a desktop app.
function AppLayoutFull() {
  return (
    <div className="kt-shell">
      <TopBar />
      <main className="kt-shell-main">
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>
          {/* Inert in the browser build (no backend process for the page to elevate) — see
              ElevationContext.tsx. */}
          <ElevationProvider>
            {/* Routes the Electron shell's native menu and kathara:// links onto the app's own
                commands. Inert in the browser build. */}
            <DesktopCommandsProvider>
              <Routes>
                {/* The Workspace is the app; "/" redirects into it. */}
                <Route path="/" element={<Navigate to="/workspace" replace />} />
                <Route element={<AppLayout />}>
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>
                <Route element={<AppLayoutFull />}>
                  <Route path="/workspace" element={<WorkspacePage />} />
                  <Route path="/workspace/:name" element={<WorkspacePage />} />
                </Route>
                {/* No AppLayout: opened as its own bare browser window/tab (see
                    services/terminalWindow.ts), not navigated to within the app shell. */}
                <Route path="/labs/:name/terminal/:machine" element={<TerminalWindowPage />} />
              </Routes>
            </DesktopCommandsProvider>
          </ElevationProvider>
        </PromptProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
