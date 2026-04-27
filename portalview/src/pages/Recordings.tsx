import Navbar from "../components/Navbar"
import { useEffect, useState } from "react"
import { api } from "../services/api"

type Recording = {
  _id: string
  url: string
  date: string
  type: string
  name: string
}

export default function Recordings() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [selected, setSelected] = useState<Recording | null>(null)

  const loadData = async () => {
    const data = await api.getRecordings()
    setRecordings(data)
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleDelete = async (id: string) => {
    await api.deleteRecording(id)
    loadData()
  }

  return (
    <>
      <Navbar />

      <div style={{ padding: "20px", color: "white", background: "#0f172a", minHeight: "100vh" }}>
        <h2>Recordings</h2>

        {recordings.length === 0 ? (
          <p>No recordings yet</p>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "20px",
            marginTop: "20px"
          }}>
            {recordings.map((rec) => (
              <div
                key={rec._id}
                style={{
                  position: "relative",
                  cursor: "pointer",
                  background: "#1f2937",
                  padding: "10px",
                  borderRadius: "10px"
                }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(rec._id)
                  }}
                  style={{
                    position: "absolute",
                    top: "10px",
                    right: "10px",
                    background: "red",
                    border: "none",
                    color: "white",
                    padding: "5px",
                    cursor: "pointer"
                  }}
                >
                  X
                </button>

                <img
                  src={rec.url}
                  alt="recording"
                  onClick={() => setSelected(rec)}
                  style={{
                    width: "100%",
                    borderRadius: "10px"
                  }}
                />

                <p style={{ marginTop: "10px", fontWeight: "bold" }}>
                  {rec.name}
                </p>

                <p style={{ fontSize: "12px" }}>
                  {rec.date}
                </p>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <div
            onClick={() => setSelected(null)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              background: "rgba(0,0,0,0.8)",
              display: "flex",
              justifyContent: "center",
              alignItems: "center"
            }}
          >
            <div onClick={(e) => e.stopPropagation()}>
              <img
                src={selected.url}
                alt="preview"
                style={{ maxWidth: "90vw", borderRadius: "10px" }}
              />

              <p style={{ marginTop: "10px", textAlign: "center" }}>
                {selected.date}
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}