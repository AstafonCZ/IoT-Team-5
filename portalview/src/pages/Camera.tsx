import Navbar from "../components/Navbar"
import { useState } from "react"
import { api } from "../services/api"

export default function Camera() {
  const [snapshot, setSnapshot] = useState<string | null>(null)

  const handleSnapshot = async () => {
    const img = "https://picsum.photos/400/250"
    setSnapshot(img)

    await api.addRecording({
      url: img,
      name: "Snapshot",
      type: "snapshot",
      date: new Date().toLocaleString()
    })
  }

  return (
    <>
      <Navbar />

      <div style={{ padding: "20px", color: "white", background: "#0f172a", minHeight: "100vh" }}>
        <h2>Camera View</h2>

        <div
          style={{
            width: "400px",
            height: "250px",
            background: "#1f2937",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            marginTop: "20px",
            borderRadius: "10px"
          }}
        >
          <span>Live Camera Feed</span>
        </div>

        <button
          onClick={handleSnapshot}
          style={{
            marginTop: "20px",
            padding: "10px",
            background: "#2563eb",
            color: "white",
            border: "none",
            cursor: "pointer"
          }}
        >
          Take Snapshot
        </button>

        {snapshot && (
          <div style={{ marginTop: "20px" }}>
            <h3>Last Snapshot:</h3>
            <img src={snapshot} alt="snapshot" style={{ borderRadius: "10px" }} />
          </div>
        )}
      </div>
    </>
  )
}