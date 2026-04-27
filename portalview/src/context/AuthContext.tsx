import { createContext, useState, useEffect } from "react"
import { api } from "../services/api"

type User = {
  username: string
  token: string
}

type AuthContextType = {
  user: User | null
  login: (username: string, password: string) => Promise<boolean>
  logout: () => void
}

export const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem("user")
    if (saved) {
      setUser(JSON.parse(saved))
    }
  }, [])

  const login = async (username: string, password: string) => {
    try {
      const res = await api.login(username, password)

      if (res.success) {
        const userData = {
          username,
          token: res.token
        }

        setUser(userData)
        localStorage.setItem("user", JSON.stringify(userData))
        return true
      }

      return false
    } catch {
      return false
    }
  }

  const logout = () => {
    setUser(null)
    localStorage.removeItem("user")
  }

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}