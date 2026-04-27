import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

import { RecordingProvider } from "./context/RecordingContext"
import { AuthProvider } from "./context/AuthContext"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <RecordingProvider>
        <App />
      </RecordingProvider>
    </AuthProvider>
  </React.StrictMode>
)