const mongoose = require("mongoose");

const TaskSchema = new mongoose.Schema({
  name: { type: String, required: [true, "name is required"] },
  description: { type: String, default: "" },
  deadline: { type: Date, required: [true, "deadline is required"] },
  completed: { type: Boolean, default: false },
  assignedUser: { type: String, default: "" },
  assignedUserName: { type: String, default: "unassigned" },
  dateCreated: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Task", TaskSchema);
