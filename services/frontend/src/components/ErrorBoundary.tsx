import { Component, type ReactNode } from "react";
import { Button } from "react-bootstrap";
import { RefreshCw } from "lucide-react";
import { useLocation } from "react-router-dom";

interface FallbackProps {
  error: Error;
}

function ErrorFallback({ error }: FallbackProps) {
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

interface BoundaryProps {
  // Changing this while a fallback is shown clears the caught error and retries rendering the
  // children — e.g. the current route's pathname, so navigating to a different lab after a crash
  // recovers instead of leaving the user stuck on the fallback forever.
  resetKey: string;
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
    console.error("Uncaught error in workspace render tree:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) return <ErrorFallback error={this.state.error} />;
    return this.props.children;
  }
}

// Any uncaught exception during render/commit anywhere below this point would otherwise unmount
// the entire app with nothing to catch it (there is no other error boundary in the tree) — a
// blank, frozen page with no way to recover short of a full reload. This turns that into a
// visible, recoverable fallback scoped to the workspace instead.
export function ErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundaryImpl resetKey={location.pathname}>{children}</ErrorBoundaryImpl>;
}
