import { Component, type ComponentType, type ReactNode } from "react";
import { Button } from "react-bootstrap";
import { RefreshCw } from "lucide-react";
import { useLocation } from "react-router-dom";
import { desktop } from "../desktop/bridge";

interface FallbackProps {
  error: Error;
}

function WorkspaceErrorFallback({ error }: FallbackProps) {
  return (
    <div className="kt-ws-empty">
      <p className="kt-ws-muted">Something went wrong displaying this workspace.</p>
      <p className="kt-ws-muted small text-break">{error.message}</p>
      <Button size="sm" variant="outline-secondary" onClick={() => window.location.reload()}>
        <RefreshCw size={14} className="me-1" />
        Reload
      </Button>
    </div>
  );
}

// Used by the app-wide boundary in main.tsx, which sits outside every provider — nothing else
// survives above it, so this can't lean on app chrome, styles scoped to the workspace, or context.
export function AppErrorFallback({ error }: FallbackProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "0.5rem", textAlign: "center", padding: "1rem" }}>
      <p>Something went wrong.</p>
      <p style={{ opacity: 0.7, fontSize: "0.875rem", wordBreak: "break-word" }}>{error.message}</p>
      <Button size="sm" variant="outline-secondary" onClick={() => window.location.reload()}>
        <RefreshCw size={14} className="me-1" />
        Reload
      </Button>
    </div>
  );
}

interface BoundaryProps {
  // Changing this while a fallback is shown clears the caught error and retries rendering the
  // children — e.g. the current route's pathname, so navigating to a different lab after a crash
  // recovers instead of leaving the user stuck on the fallback forever.
  resetKey: string;
  fallback: ComponentType<FallbackProps>;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

class ErrorBoundaryImpl extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("Uncaught error in render tree:", error, info.componentStack);
    // Best-effort trail into backend.log ("Help -> Show backend log"): a packaged app's renderer
    // console isn't visible anywhere, so without this the error is undiagnosable after the fact.
    // No-ops in the browser/dev-server build, where desktop() is null.
    desktop()
      ?.logRendererError(`${error.stack ?? error.message}\n${info.componentStack}`)
      .catch(() => {});
  }

  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      const Fallback = this.props.fallback;
      return <Fallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

// Two boundaries exist in this app: this one (used around WorkspacePage in App.tsx) scopes a
// crash to the workspace so app chrome (nav, TitleBar, DockerStatusBanner) survives it, and a
// second, app-wide one in main.tsx catches everything this one structurally can't reach —
// provider bodies and their sibling modals, SettingsPage, TerminalWindowPage, chrome itself. Any
// uncaught exception outside both would otherwise unmount the entire app with nothing to catch
// it — a blank, frozen page with no way to recover short of a full reload.
export function ErrorBoundary({
  children,
  fallback = WorkspaceErrorFallback,
}: {
  children: ReactNode;
  fallback?: ComponentType<FallbackProps>;
}) {
  const location = useLocation();
  return (
    <ErrorBoundaryImpl resetKey={location.pathname} fallback={fallback}>
      {children}
    </ErrorBoundaryImpl>
  );
}
