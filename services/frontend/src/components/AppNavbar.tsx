import { Badge, Container, Nav, Navbar } from "react-bootstrap";
import { Link } from "react-router-dom";
import katharaLogo from "../assets/kathara-logo.png";
import katharaLogoDark from "../assets/kathara-logo-dark.png";
import { useHealth } from "../hooks/useHealth";
import { useTheme } from "../hooks/useTheme";

// The browser top bar. In the Electron shell it is replaced by desktop/TitleBar.tsx, which folds
// the same content into the window's own title strip — see App.tsx.
export function AppNavbar() {
  const health = useHealth();
  const { theme, dark } = useTheme();

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
          <Badge bg={health === "ok" ? "success" : health === "down" ? "danger" : "secondary"}>
            {health === "checking" ? "checking…" : health === "ok" ? "healthy" : "server unreachable"}
          </Badge>
        </Navbar.Text>
      </Container>
    </Navbar>
  );
}
