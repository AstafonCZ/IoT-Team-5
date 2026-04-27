import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { useContext } from "react"

import Login from "./pages/Login"
import Register from "./pages/Register"
import Dashboard from "./pages/Dashboard"
import Camera from "./pages/Camera"
import Recordings from "./pages/Recordings"

import { AuthContext } from "./context/AuthContext"

function App() {
  const context = useContext(AuthContext)
  if (!context) throw new Error("AuthContext not found")

  const { user } = context

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={!user ? <Login /> : <Navigate to="/dashboard" />}
        />

        <Route
          path="/register"
          element={!user ? <Register /> : <Navigate to="/dashboard" />}
        />

        <Route
          path="/dashboard"
          element={user ? <Dashboard /> : <Navigate to="/" />}
        />

        <Route
          path="/camera"
          element={user ? <Camera /> : <Navigate to="/" />}
        />

        <Route
          path="/recordings"
          element={user ? <Recordings /> : <Navigate to="/" />}
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App