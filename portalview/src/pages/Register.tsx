import { useNavigate } from "react-router-dom"
import { useState } from "react"
import { api } from "../services/api"

export default function Register() {
  const navigate = useNavigate()

  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const handleRegister = async () => {
    if (!username || !password) return
    if (password !== confirmPassword) return

    try {
      const res = await api.register(username, password)

      if (res.success) {
        navigate("/")
      } else {
        alert(res.message || "Register failed")
      }
    } catch {
      alert("Server error")
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
        <h2 style={{ marginBottom: "20px" }}>Register</h2>

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
            marginBottom: "10px"
          }}
        />

        <input
          type="password"
          placeholder="Confirm Password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          style={{
            width: "100%",
            padding: "10px",
            marginBottom: "20px"
          }}
        />

        <button
          onClick={handleRegister}
          style={{
            width: "100%",
            padding: "10px",
            background: "#16a34a",
            color: "white",
            border: "none",
            cursor: "pointer"
          }}
        >
          Register
        </button>

        <p style={{ marginTop: "15px", fontSize: "12px" }}>
          Already have an account?{" "}
          <span
            onClick={() => navigate("/")}
            style={{ color: "#3b82f6", cursor: "pointer" }}
          >
            Login
          </span>
        </p>
      </div>
    </div>
  )
}