const express = require("express")
const Recording = require("../models/Recording")
const authMiddleware = require("../middleware/auth")

const router = express.Router()

router.get("/", authMiddleware, async (req, res) => {
  const recordings = await Recording.find({ userId: req.user.id })
  res.json(recordings)
})

router.post("/", authMiddleware, async (req, res) => {
  const { url, name, type, date } = req.body

  const recording = new Recording({
    userId: req.user.id,
    url,
    name,
    type,
    date
  })

  await recording.save()
  res.json(recording)
})

router.delete("/:id", authMiddleware, async (req, res) => {
  await Recording.deleteOne({
    _id: req.params.id,
    userId: req.user.id
  })

  res.json({ success: true })
})

module.exports = router