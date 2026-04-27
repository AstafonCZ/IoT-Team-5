import { createContext, useState, useEffect } from "react"
import type { Recording, RecordingType } from "../models/Recording"

type RecordingContextType = {
  recordings: Recording[]
  addRecording: (img: string, type?: RecordingType) => void
  deleteRecording: (id: string) => void
}

export const RecordingContext = createContext<RecordingContextType | null>(null)

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const [recordings, setRecordings] = useState<Recording[]>([])

  useEffect(() => {
    const saved = localStorage.getItem("recordings")
    if (saved) {
      setRecordings(JSON.parse(saved))
    }
  }, [])

  useEffect(() => {
    localStorage.setItem("recordings", JSON.stringify(recordings))
  }, [recordings])

  const addRecording = (img: string, type: RecordingType = "snapshot") => {
    const now = new Date()

    const newRecording: Recording = {
      id: crypto.randomUUID(),
      url: img,
      date: now.toLocaleString(),
      type,
      name: `${type.toUpperCase()} - ${now.toLocaleTimeString()}`
    }

    setRecordings((prev) => [newRecording, ...prev])
  }

  const deleteRecording = (id: string) => {
    setRecordings((prev) => prev.filter((rec) => rec.id !== id))
  }

  return (
    <RecordingContext.Provider value={{ recordings, addRecording, deleteRecording }}>
      {children}
    </RecordingContext.Provider>
  )
}