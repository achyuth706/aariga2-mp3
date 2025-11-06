const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Task = require('../models/Task');

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

// GET /api/users
router.get('/', async (req, res) => {
    try {
        const where = parseJSONParam(req.query.where, {});
        const sort = parseJSONParam(req.query.sort, {});
        const select = parseJSONParam(req.query.select, {});
        const skip = intOrUndefined(req.query.skip);
        const limit = intOrUndefined(req.query.limit);
        const count = req.query.count === 'true';

        if (count) {
            const total = await User.countDocuments(where);
            return res.status(200).json({ message: 'OK', data: total });
        }

        let q = User.find(where);
        if (Object.keys(sort).length) q = q.sort(sort);
        if (Object.keys(select).length) q = q.select(select);
        if (skip !== undefined) q = q.skip(skip);
        if (limit !== undefined) q = q.limit(limit);

        const users = await q.exec();
        return res.status(200).json({ message: 'OK', data: users });
    } catch (err) {
        const msg = err.message === 'Invalid JSON in query parameter'
            ? 'Bad Request: one of where/sort/select contains invalid JSON'
            : 'Server Error while fetching users';
        const code = msg.startsWith('Bad Request') ? 400 : 500;
        return res.status(code).json({ message: msg, data: null });
    }
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
    try {
        const select = parseJSONParam(req.query.select, {});
        const user = await User.findById(req.params.id).select(select);
        if (!user) return res.status(404).json({ message: 'User not found', data: null });
        return res.status(200).json({ message: 'OK', data: user });
    } catch {
        return res.status(400).json({ message: 'Bad Request: invalid user id', data: null });
    }
});

// POST /api/users
router.post('/', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
        if (!name || !email) {
            return res.status(400).json({ message: 'name and email are required', data: null });
        }

        const existing = await User.findOne({ email });
        if (existing) {
            return res.status(400).json({ message: 'A user with this email already exists', data: null });
        }

        const pending = Array.isArray(req.body.pendingTasks) ? req.body.pendingTasks.map(String) : [];

        // Ensure no completed tasks are added
        if (pending.length > 0) {
            const invalid = await Task.find({ _id: { $in: pending }, completed: true });
            if (invalid.length > 0) {
                return res.status(400).json({ message: 'Cannot add completed tasks to pendingTasks', data: null });
            }
        }

        const user = new User({ name, email, pendingTasks: pending });
        await user.save();

        // Two-way sync: assign user to all pendingTasks
        if (pending.length > 0) {
            await Task.updateMany(
                { _id: { $in: pending } },
                { $set: { assignedUser: user._id.toString(), assignedUserName: user.name } }
            );
        }

        return res.status(201).json({ message: 'User created', data: user });
    } catch {
        return res.status(500).json({ message: 'Server Error while creating user', data: null });
    }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
        if (!name || !email) {
            return res.status(400).json({ message: 'name and email are required', data: null });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found', data: null });

        const existing = await User.findOne({ email, _id: { $ne: req.params.id } });
        if (existing) {
            return res.status(400).json({ message: 'A user with this email already exists', data: null });
        }

        user.name = name;
        user.email = email;

        const incomingPending = Array.isArray(req.body.pendingTasks) ? req.body.pendingTasks.map(String) : user.pendingTasks.map(String);

        // Prevent adding completed tasks
        if (incomingPending.length > 0) {
            const invalid = await Task.find({ _id: { $in: incomingPending }, completed: true });
            if (invalid.length > 0) {
                return res.status(400).json({ message: 'Cannot add completed tasks to pendingTasks', data: null });
            }
        }

        const prevAssignedSet = new Set((user.pendingTasks || []).map(String));
        const incomingSet = new Set(incomingPending);

        const toAssign = [...incomingSet].filter(id => !prevAssignedSet.has(id));
        const toUnassign = [...prevAssignedSet].filter(id => !incomingSet.has(id));

        if (toAssign.length) {
            const tasks = await Task.find({ _id: { $in: toAssign } });
            await Promise.all(tasks.map(async (t) => {
                t.assignedUser = user._id.toString();
                t.assignedUserName = user.name;
                await t.save();
            }));
        }

        if (toUnassign.length) {
            await Task.updateMany(
                { _id: { $in: toUnassign }, assignedUser: user._id.toString() },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
            );
        }

        user.pendingTasks = incomingPending;
        await user.save();

        return res.status(200).json({ message: 'User updated', data: user });
    } catch (err) {
        const msg = err.name === 'CastError'
            ? 'Bad Request: invalid user id'
            : 'Server Error while updating user';
        const code = err.name === 'CastError' ? 400 : 500;
        return res.status(code).json({ message: msg, data: null });
    }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found', data: null });

        await Task.updateMany(
            { assignedUser: user._id.toString() },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );

        return res.status(204).json({ message: 'User deleted', data: null });
    } catch {
        return res.status(400).json({ message: 'Bad Request: invalid user id', data: null });
    }
});

module.exports = router;
