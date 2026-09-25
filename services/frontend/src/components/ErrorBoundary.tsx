import { Component, type ComponentType, type ReactNode, useEffect, useState } from "react";
import { Button } from "react-bootstrap";
import { RefreshCw } from "lucide-react";
import { useLocation } from "react-router-dom";
import { desktop, isDesktop } from "../desktop/bridge";
import { copyText } from "../services/clipboard";

interface FallbackProps {
  error: Error;
}

// Same repo pyproject.toml lists under "Bug Reports" — the canonical upstream, not the fork
// updateCheck.ts polls for releases (see that file's own comment on the difference).
const ISSUES_URL = "https://github.com/KatharaFramework/kathara-desktop/issues/new";

interface CrashScreenProps extends FallbackProps {
  heading: string;
  /** True for the app-wide boundary's fallback, which replaces the entire window (no chrome
   * above it) and so needs to claim the full viewport height the way setup.html's own <body>
   * does. False for the workspace-scoped one, which already sits inside a sized flex area under
   * the app's own top bar (see kt-shell-main in WorkspacePage.css) — claiming 100vh there would
   * push it taller than that area and clip under its parent's overflow:hidden. */
  fullPage?: boolean;
}

/** Mirrors the desktop shell's own crash screen (services/desktop/src/setup.html) as closely as
 * plain CSS variables allow — same left-aligned block layout, bold heading, muted body copy, and
 * bordered log box — so a backend crash and a frontend crash read as the same kind of screen
 * instead of two differently-designed ones. Bootstrap's `--bs-*` tokens (not hardcoded colors)
 * keep it in sync with the app's own light/dark theme (see useTheme.ts's `data-bs-theme`), same
 * as setup.html's own CSS variables track the OS scheme. */
function CrashScreen({ error, heading, fullPage }: CrashScreenProps) {
  const [logText, setLogText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    desktop()
      ?.getLogTail(200)
      .then(setLogText)
      .catch(() => setLogText(""));
  }, []);

  return (
    <div style={{ padding: "2.5rem clamp(1.5rem, 6vw, 4rem)", ...(fullPage ? { minHeight: "100vh" } : {}) }}>
      <h1 style={{ fontSize: "1.35rem", fontWeight: 600, margin: "0 0 0.35rem" }}>{heading}</h1>
      <p style={{ color: "var(--bs-secondary-color)", margin: "0 0 1.75rem", wordBreak: "break-word" }}>
        {error.message}
      </p>
      {isDesktop() && (
        <>
          <p style={{ color: "var(--bs-secondary-color)", margin: "0 0 1.75rem" }}>
            If this looks like a bug,{" "}
            <Button
              variant="link"
              className="p-0 align-baseline"
              onClick={() => desktop()?.openExternal(ISSUES_URL)}
            >
              open a GitHub issue
            </Button>{" "}
            describing the steps that led here, with the log below pasted in — that's what
            actually gets it fixed.
          </p>
          <details style={{ margin: "0 0 1.25rem" }}>
            <summary style={{ cursor: "pointer", color: "var(--bs-secondary-color)" }}>
              Technical details
            </summary>
            <pre
              style={{
                marginTop: "0.5rem",
                maxHeight: "15rem",
                overflow: "auto",
                fontSize: "0.78rem",
                background: "var(--bs-tertiary-bg)",
                border: "1px solid var(--bs-border-color)",
                borderRadius: "6px",
                padding: "0.8rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {logText ?? "Loading…"}
            </pre>
          </details>
        </>
      )}
      <div className="d-flex gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          <RefreshCw size={14} className="me-1" />
          Reload
        </Button>
        {isDesktop() && (
          <Button
            variant="outline-secondary"
            disabled={logText === null}
            onClick={() => {
              copyText(logText ?? "")
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch(() => {});
            }}
          >
            {copied ? "Copied!" : "Copy log"}
          </Button>
        )}
      </div>
    </div>
  );
}

function WorkspaceErrorFallback({ error }: FallbackProps) {
  return <CrashScreen error={error} heading="Something went wrong displaying this workspace." />;
}

// Used by the app-wide boundary in main.tsx, which sits outside every provider — nothing else
// survives above it, so this can't lean on app chrome, styles scoped to the workspace, or context.
export function AppErrorFallback({ error }: FallbackProps) {
  return <CrashScreen error={error} heading="Something went wrong." fullPage />;
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
