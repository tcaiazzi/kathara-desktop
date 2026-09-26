import { HelpCircle } from "lucide-react";
import { Container, Nav, Navbar } from "react-bootstrap";
import { Link } from "react-router-dom";
import katharaLogo from "../assets/kathara-logo.png";
import katharaLogoDark from "../assets/kathara-logo-dark.png";
import { useOnboardingTour } from "../context/OnboardingTourContext";
import { useGuardedLinkClick } from "../context/UnsavedChangesContext";
import { useTheme } from "../hooks/useTheme";
import { ImageDownloadBadge } from "./ImageDownloadBadge";
import { NotificationsPanel } from "./NotificationsPanel";
import { HealthBadge, PrivilegedBadge } from "./StatusBadges";

// The browser top bar. In the Electron shell it is replaced by desktop/TitleBar.tsx, which folds
// the same content into the window's own title strip — see App.tsx.
export function AppNavbar() {
  const { theme, dark } = useTheme();
  const { requestTour } = useOnboardingTour();
  const guardedClick = useGuardedLinkClick();

  return (
    <Navbar bg={theme} variant={theme} expand="sm" className="mb-3">
      <Container fluid>
        <Navbar.Brand
          as={Link}
          to="/workspace"
          onClick={guardedClick("/workspace")}
          className="kt-navbar-brand"
          title="Kathara Desktop"
        >
          {/* Dark theme uses the white-wordmark logo so it reads on the dark navbar without a chip. */}
          <img src={dark ? katharaLogoDark : katharaLogo} alt="Kathara" height={30} />
        </Navbar.Brand>
        <Nav className="me-auto">
          <Nav.Link as={Link} to="/workspace" onClick={guardedClick("/workspace")}>
            Workspace
          </Nav.Link>
          <Nav.Link as={Link} to="/settings" onClick={guardedClick("/settings")}>
            Settings
          </Nav.Link>
        </Nav>
        <Navbar.Text className="d-flex align-items-center gap-2">
          <PrivilegedBadge />
          <HealthBadge />
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary d-flex align-items-center"
            title="Show onboarding tour"
            aria-label="Show onboarding tour"
            onClick={() => requestTour({ auto: false })}
          >
            <HelpCircle size={16} />
          </button>
          <ImageDownloadBadge />
          <NotificationsPanel />
        </Navbar.Text>
      </Container>
    </Navbar>
  );
}
