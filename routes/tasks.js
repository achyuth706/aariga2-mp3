const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const User = require('../models/user');

function parseJSONParam(value, fallback = {}) {
    if (value === undefined) return fallback;
    try { return JSON.parse(value); }
    catch { throw new Error('Invalid JSON in query parameter'); }
}

function intOrUndefined(v) {
    if (v === undefined) return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
}

async function loadUserOrNull(id) {
    try { return await User.findById(id); } catch { return null; }
}

/* ======================= GET ALL TASKS ======================= */
router.get('/', async (req, res) => {
    try {
        const where = parseJSONParam(req.query.where, {});
        const sort = parseJSONParam(req.query.sort, {});
        const select = parseJSONParam(req.query.select, {});
        const skip = intOrUndefined(req.query.skip);
        const limit = intOrUndefined(req.query.limit);
        const count = req.query.count === 'true';

        if (count) {
            const total = await Task.countDocuments(where);
            return res.status(200).json({ message: 'OK', data: total });
        }

        let q = Task.find(where);
        if (Object.keys(sort).length) q = q.sort(sort);
        if (Object.keys(select).length) q = q.select(select);
        if (skip !== undefined) q = q.skip(skip);
        if (limit !== undefined) q = q.limit(limit);

        const tasks = await q.exec();
        return res.status(200).json({ message: 'OK', data: tasks });
    } catch (err) {
        const msg = err.message === 'Invalid JSON in query parameter'
            ? 'Bad Request: one of where/sort/select contains invalid JSON'
            : 'Server Error while fetching tasks';
        const code = msg.startsWith('Bad Request') ? 400 : 500;
        return res.status(code).json({ message: msg, data: null });
    }
});

/* ======================= GET ONE TASK ======================= */
router.get('/:id', async (req, res) => {
    try {
        const select = parseJSONParam(req.query.select, {});
        const task = await Task.findById(req.params.id).select(select);
        if (!task) return res.status(404).json({ message: 'Task not found', data: null });
        return res.status(200).json({ message: 'OK', data: task });
    } catch {
        return res.status(400).json({ message: 'Bad Request: invalid task id', data: null });
    }
});

/* ======================= CREATE TASK (POST) ======================= */
router.post('/', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const deadline = req.body.deadline;
        const completed = typeof req.body.completed === 'boolean' ? req.body.completed : false;
        const assignedUserIdRaw = typeof req.body.assignedUser === 'string' ? req.body.assignedUser : '';

        if (!name || !deadline) {
            return res.status(400).json({ message: 'name and deadline are required', data: null });
        }

        // ✅ Rule: Cannot assign a completed task to a user
        if (completed && assignedUserIdRaw) {
            return res.status(400).json({ message: 'Cannot assign a completed task to a user', data: null });
        }

        const description = typeof req.body.description === 'string' ? req.body.description : '';
        let assignedUserId = assignedUserIdRaw;
        let assignedUserName = typeof req.body.assignedUserName === 'string' ? req.body.assignedUserName : 'unassigned';

        let assignedUser = null;
        if (assignedUserId) {
            assignedUser = await loadUserOrNull(assignedUserId);
            if (!assignedUser) {
                assignedUserId = '';
                assignedUserName = 'unassigned';
            } else {
                assignedUserName = assignedUser.name;
            }
        }

        const task = new Task({
            name,
            description,
            deadline,
            completed,
            assignedUser: assignedUserId,
            assignedUserName
        });

        await task.save();

        // ✅ Add to pending only if assigned + not completed
        if (assignedUser && !task.completed) {
            assignedUser.pendingTasks = Array.from(
                new Set([...(assignedUser.pendingTasks || []).map(String), task._id.toString()])
            );
            await assignedUser.save();
        }

        return res.status(201).json({ message: 'Task created', data: task });
    } catch {
        return res.status(500).json({ message: 'Server Error while creating task', data: null });
    }
});

/* ======================= UPDATE TASK (PUT) ======================= */
router.put('/:id', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const deadline = req.body.deadline;
        if (!name || !deadline) {
            return res.status(400).json({ message: 'name and deadline are required', data: null });
        }

        const task = await Task.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Task not found', data: null });

        // ✅ Rule: if task already completed → cannot reassign
        const reqAssignedUserId = typeof req.body.assignedUser === 'string' ? req.body.assignedUser : '';
        if (task.completed && reqAssignedUserId && reqAssignedUserId !== String(task.assignedUser)) {
            return res.status(400).json({
                message: 'Cannot reassign a task that is already completed',
                data: null
            });
        }

        const prevAssignedUserId = task.assignedUser ? String(task.assignedUser) : '';

        task.name = name;
        task.deadline = deadline;
        task.description = typeof req.body.description === 'string' ? req.body.description : '';
        task.completed = typeof req.body.completed === 'boolean' ? req.body.completed : false;

        let newAssignedUserId = reqAssignedUserId || prevAssignedUserId;
        let newAssignedUser = null;

        if (newAssignedUserId) {
            newAssignedUser = await loadUserOrNull(newAssignedUserId);
            if (!newAssignedUser) {
                newAssignedUserId = '';
                task.assignedUserName = 'unassigned';
            } else {
                task.assignedUserName = newAssignedUser.name;
            }
        } else {
            task.assignedUserName = 'unassigned';
        }

        task.assignedUser = newAssignedUserId;
        await task.save();

        if (prevAssignedUserId && prevAssignedUserId !== newAssignedUserId) {
            await User.updateOne(
                { _id: prevAssignedUserId },
                { $pull: { pendingTasks: task._id.toString() } }
            );
        }

        if (newAssignedUser && !task.completed) {
            await User.updateOne(
                { _id: newAssignedUser._id },
                { $addToSet: { pendingTasks: task._id.toString() } }
            );
        }

        if (task.completed && newAssignedUserId) {
            await User.updateOne(
                { _id: newAssignedUserId },
                { $pull: { pendingTasks: task._id.toString() } }
            );
        }

        return res.status(200).json({ message: 'Task updated', data: task });
    } catch (err) {
        const msg = err.name === 'CastError'
            ? 'Bad Request: invalid task id'
            : 'Server Error while updating task';
        const code = err.name === 'CastError' ? 400 : 500;
        return res.status(code).json({ message: msg, data: null });
    }
});

/* ======================= DELETE TASK ======================= */
router.delete('/:id', async (req, res) => {
    try {
        const task = await Task.findByIdAndDelete(req.params.id);
        if (!task) return res.status(404).json({ message: 'Task not found', data: null });

        if (task.assignedUser) {
            await User.updateOne(
                { _id: task.assignedUser },
                { $pull: { pendingTasks: task._id.toString() } }
            );
        }

        return res.status(204).json({ message: 'Task deleted', data: null });
    } catch {
        return res.status(400).json({ message: 'Bad Request: invalid task id', data: null });
    }
});

module.exports = router;
