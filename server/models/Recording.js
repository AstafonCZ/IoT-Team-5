const mongoose = require("mongoose")

const recordingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  url: {
    type: String,
    required: true
  },
  date: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ["snapshot", "video"],
    default: "snapshot"
  },
  name: {
    type: String,
    required: true
  }
})

module.exports = mongoose.model("Recording", recordingSchema)