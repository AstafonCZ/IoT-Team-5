const express = require("express")
const bcrypt = require("bcrypt")
const jwt = require("jsonwebtoken")
const User = require("../models/User")

const router = express.Router()

router.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body

    const existing = await User.findOne({ username })
    if (existing) {
      return res.json({ success: false, message: "User exists" })
    }

    const hashed = await bcrypt.hash(password, 10)

    const user = new User({
      username,
      password: hashed
    })

    await user.save()

    res.json({ success: true })
  } catch {
    res.json({ success: false, message: "Error" })
  }
})

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body

    const user = await User.findOne({ username })
    if (!user) {
      return res.json({ success: false, message: "Invalid credentials" })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return res.json({ success: false, message: "Invalid credentials" })
    }

    const token = jwt.sign(
      { id: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    )

    res.json({
      success: true,
      token
    })
  } catch {
    res.json({ success: false, message: "Error" })
  }
})

module.exports = router