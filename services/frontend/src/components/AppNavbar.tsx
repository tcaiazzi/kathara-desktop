import { useEffect, useState } from "react";
import { Badge, Button, Container, Nav, Navbar } from "react-bootstrap";
import { Link } from "react-router-dom";
import katharaLogo from "../assets/kathara-logo.png";
import katharaLogoDark from "../assets/kathara-logo-dark.png";
import { api } from "../services/api";
import type { SystemInfo } from "../services/types";

type Health = "checking" | "ok" | "down";
type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "kt-ui-theme";

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "light";
}

export function AppNavbar() {
  const [health, setHealth] = useState<Health>("checking");
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-bs-theme", theme);
    root.setAttribute("data-kt-theme", theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.health();
        if (cancelled) return;
        setHealth("ok");
        setSystem(await api.systemInfo());
      } catch {
        if (!cancelled) setHealth("down");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dark = theme === "dark";
  return (
    <Navbar bg={theme} variant={theme} expand="sm" className="mb-3">
      <Container fluid>
        <Navbar.Brand as={Link} to="/workspace" className="kt-navbar-brand" title="Kathara Control Panel">
          {/* Dark theme uses the white-wordmark logo so it reads on the dark navbar without a chip. */}
          <img src={dark ? katharaLogoDark : katharaLogo} alt="Kathara" height={30} />
        </Navbar.Brand>
        <Nav className="me-auto">
          <Nav.Link as={Link} to="/workspace">
            Workspace
          </Nav.Link>
          <Nav.Link as={Link} to="/settings">
            Settings
          </Nav.Link>
        </Nav>
        <Navbar.Text className="d-flex align-items-center gap-2">
          <Button
            variant={dark ? "outline-light" : "outline-dark"}
            size="sm"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? "Dark theme" : "Light theme"}
          </Button>
          <Badge bg={health === "ok" ? "success" : health === "down" ? "danger" : "secondary"}>
            {health === "checking" ? "checking…" : health === "ok" ? "healthy" : "server unreachable"}
          </Badge>
          {system && (
            <span className={`small ${dark ? "text-white-50" : "text-body-secondary"}`}>
              manager: {system.manager} · version: {system.version}
            </span>
          )}
        </Navbar.Text>
      </Container>
    </Navbar>
  );
}
