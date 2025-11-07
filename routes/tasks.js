const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');

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

function isValidObjectId(id) {
    return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

router.get('/', async (req, res) => {
    try {
        const where = parseJSONParam(req.query.where, {});
        const sort = parseJSONParam(req.query.sort, {});
        const select = parseJSONParam(req.query.select, {});
        const skip = intOrUndefined(req.query.skip) || 0;
        const limit = intOrUndefined(req.query.limit);
        const count = req.query.count === 'true';

        let q = Task.find(where);
        if (Object.keys(sort).length) q = q.sort(sort);
        if (Object.keys(select).length) q = q.select(select);
        if (skip) q = q.skip(skip);
        if (limit !== undefined) q = q.limit(limit);

        if (count) {
            const pageDocs = await q.select({ _id: 1 }).lean().exec();
            return res.status(200).json({ message: 'OK', data: pageDocs.length });
        }

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

router.post('/', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const deadline = req.body.deadline;

        if (!name || !deadline) {
            return res.status(400).json({ message: 'name and deadline are required', data: null });
        }

        const description = typeof req.body.description === 'string' ? req.body.description : '';
        const completed = (req.body.completed === true || req.body.completed === "true");

        let assignedUserId = typeof req.body.assignedUser === 'string' ? req.body.assignedUser.trim() : '';
        let assignedUserName = typeof req.body.assignedUserName === 'string' ? req.body.assignedUserName : 'unassigned';

        let assignedUser = null;

        if (assignedUserId) {
            if (!isValidObjectId(assignedUserId)) {
                return res.status(400).json({ message: 'Bad Request: assignedUser is not a valid id', data: null });
            }

            assignedUser = await User.findById(assignedUserId);
            if (!assignedUser) {
                return res.status(400).json({ message: 'Bad Request: assignedUser does not exist', data: null });
            }

            if (req.body.assignedUserName && req.body.assignedUserName !== assignedUser.name) {
                return res.status(400).json({ message: 'Bad Request: assignedUserName does not match assignedUser', data: null });
            }

            assignedUserName = assignedUser.name;
        } else {
            assignedUserName = 'unassigned';
            assignedUserId = '';
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

        if (assignedUser && !task.completed) {
            await User.updateOne(
                { _id: assignedUser._id },
                { $addToSet: { pendingTasks: task._id.toString() } }
            );
        }

        return res.status(201).json({ message: 'Task created', data: task });

    } catch {
        return res.status(500).json({ message: 'Server Error while creating task', data: null });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const deadline = req.body.deadline;

        if (!name || !deadline) {
            return res.status(400).json({ message: 'name and deadline are required', data: null });
        }

        const task = await Task.findById(req.params.id);
        if (!task) return res.status(404).json({ message: 'Task not found', data: null });

        const prevAssignedUserId = task.assignedUser ? String(task.assignedUser) : '';

        task.name = name;
        task.deadline = deadline;
        task.description = typeof req.body.description === 'string' ? req.body.description : '';
        task.completed = (req.body.completed === true || req.body.completed === "true");

        let newAssignedUserId = typeof req.body.assignedUser === 'string'
            ? req.body.assignedUser.trim()
            : (task.assignedUser || '').toString();

        let newAssignedUser = null;

        if (newAssignedUserId) {
            if (!isValidObjectId(newAssignedUserId)) {
                return res.status(400).json({ message: 'Bad Request: assignedUser is not a valid id', data: null });
            }

            newAssignedUser = await User.findById(newAssignedUserId);
            if (!newAssignedUser) {
                return res.status(400).json({ message: 'Bad Request: assignedUser does not exist', data: null });
            }

            if (req.body.assignedUserName && req.body.assignedUserName !== newAssignedUser.name) {
                return res.status(400).json({ message: 'Bad Request: assignedUserName does not match assignedUser', data: null });
            }

            if (task.completed && newAssignedUserId !== prevAssignedUserId) {
                return res.status(400).json({ message: 'Cannot reassign a completed task', data: null });
            }

            task.assignedUserName = newAssignedUser.name;
        } else {
            task.assignedUserName = 'unassigned';
            newAssignedUserId = '';
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