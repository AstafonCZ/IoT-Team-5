const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
require("dotenv").config()

const authRoutes = require("./routes/auth")
const recordingRoutes = require("./routes/recordings")
const authMiddleware = require("./middleware/auth")

const app = express()

app.use(cors())
app.use(express.json())

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(() => console.log("DB error"))

app.use("/auth", authRoutes)
app.use("/recordings", recordingRoutes)

app.get("/protected", authMiddleware, (req, res) => {
  res.json({
    success: true,
    user: req.user
  })
})

app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`)
})