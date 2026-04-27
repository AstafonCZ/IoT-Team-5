import Navbar from "../components/Navbar"
import { useNavigate } from "react-router-dom"
import { useContext } from "react"
import { AuthContext } from "../context/AuthContext"
import { api } from "../services/api"

export default function Dashboard() {
  const navigate = useNavigate()

  const context = useContext(AuthContext)
  if (!context) throw new Error("AuthContext not found")

  const { logout } = context

  const handleLogout = () => {
    logout()
    navigate("/")
  }

  const handleTest = async () => {
    const res = await api.getRecordings()
    console.log(res)
  }

  return (
    <>
      <Navbar />

      <div style={{ padding: "20px", color: "white" }}>
        <h2>Dashboard Overview</h2>
        <p>System status and alerts will be here</p>

        <button
          onClick={handleTest}
          style={{
            marginTop: "20px",
            padding: "10px",
            background: "#2563eb",
            color: "white",
            border: "none",
            cursor: "pointer"
          }}
        >
          Test API
        </button>

        <button
          onClick={handleLogout}
          style={{
            marginTop: "20px",
            marginLeft: "10px",
            padding: "10px",
            background: "red",
            color: "white",
            border: "none",
            cursor: "pointer"
          }}
        >
          Logout
        </button>
      </div>
    </>
  )
}