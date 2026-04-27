import { Link } from "react-router-dom"

export default function Navbar() {
  return (
    <div style={{
      background: "#111",
      color: "white",
      padding: "12px",
      display: "flex",
      gap: "20px"
    }}>
      <span style={{ fontWeight: "bold" }}>PortalView</span>

      <Link to="/dashboard" style={{ color: "white" }}>
        Dashboard
      </Link>

      <Link to="/camera" style={{ color: "white" }}>
        Camera
      </Link>

      <Link to="/recordings" style={{ color: "white" }}>
        Recordings
      </Link>
    </div>
  )
}