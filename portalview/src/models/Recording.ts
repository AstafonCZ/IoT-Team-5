export type RecordingType = "snapshot" | "video"

export interface Recording {
  id: string
  url: string
  date: string
  type: RecordingType
  name: string
}