const BASE_URL = "http://localhost:5000"

const getToken = () => {
  const user = localStorage.getItem("user")
  if (!user) return null
  return JSON.parse(user).token
}

const authHeader = () => ({
  Authorization: `Bearer ${getToken()}`
})

export const api = {
  register: async (username: string, password: string) => {
    const res = await fetch(`${BASE_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    })
    return res.json()
  },

  login: async (username: string, password: string) => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    })
    return res.json()
  },

  getRecordings: async () => {
    const res = await fetch(`${BASE_URL}/recordings`, {
      headers: authHeader()
    })
    return res.json()
  },

  addRecording: async (data: any) => {
    const res = await fetch(`${BASE_URL}/recordings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader()
      },
      body: JSON.stringify(data)
    })
    return res.json()
  },

  deleteRecording: async (id: string) => {
    const res = await fetch(`${BASE_URL}/recordings/${id}`, {
      method: "DELETE",
      headers: authHeader()
    })
    return res.json()
  }
}