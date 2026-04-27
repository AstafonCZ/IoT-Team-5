import { useNavigate } from "react-router-dom"
import { useContext, useState } from "react"
import { AuthContext } from "../context/AuthContext"

export default function Login() {
  const context = useContext(AuthContext)
  if (!context) throw new Error("AuthContext not found")

  const { login } = context

  const navigate = useNavigate()

  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")

  const handleLogin = async () => {
    const success = await login(username, password)

    if (success) {
      navigate("/dashboard")
    } else {
      alert("Invalid credentials")
    }
  }

  return (
    <div style={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      height: "100vh",
      background: "#0f172a",
      color: "white"
    }}>
      <div style={{
        background: "#111827",
        padding: "30px",
        borderRadius: "10px",
        width: "300px"
      }}>
        <h2 style={{ marginBottom: "20px" }}>PortalView Login</h2>

        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={{
            width: "100%",
            padding: "10px",
            marginBottom: "10px"
          }}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            width: "100%",
            padding: "10px",
            marginBottom: "20px"
          }}
        />

        <button
          onClick={handleLogin}
          style={{
            width: "100%",
            padding: "10px",
            background: "#2563eb",
            color: "white",
            border: "none",
            cursor: "pointer"
          }}
        >
          Login
        </button>

        <p style={{ marginTop: "15px", fontSize: "12px" }}>
          Don't have an account?{" "}
          <span
            onClick={() => navigate("/register")}
            style={{ color: "#3b82f6", cursor: "pointer" }}
          >
            Register
          </span>
        </p>
      </div>
    </div>
  )
}