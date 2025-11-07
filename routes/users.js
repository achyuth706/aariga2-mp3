const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user_temp');
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

        let q = User.find(where);
        if (Object.keys(sort).length) q = q.sort(sort);
        if (Object.keys(select).length) q = q.select(select);
        if (skip) q = q.skip(skip);
        if (limit !== undefined) q = q.limit(limit);

        if (count) {
            const pageDocs = await q.select({ _id: 1 }).lean().exec();
            return res.status(200).json({ message: 'OK', data: pageDocs.length });
        }

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

router.post('/', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';

        if (!name || !email) {
            return res.status(400).json({ message: 'name and email are required', data: null });
        }

        const existing = await User.findOne({ email });
        if (existing) {
            return res.status(400).json({ message: 'A user with this email already exists', data: null });
        }

        const user = new User({
            name,
            email,
            pendingTasks: []
        });
        await user.save();

        if (Array.isArray(req.body.pendingTasks) && req.body.pendingTasks.length) {
            const incoming = [...new Set(req.body.pendingTasks.map(String))];

            for (const tid of incoming) {
                if (!isValidObjectId(tid)) {
                    return res.status(400).json({ message: 'Bad Request: pendingTasks contains invalid task id', data: null });
                }
            }

            const tasks = await Task.find({ _id: { $in: incoming } });
            if (tasks.length !== incoming.length) {
                return res.status(404).json({ message: 'One or more tasks in pendingTasks do not exist', data: null });
            }

            if (tasks.some(t => t.completed)) {
                return res.status(400).json({ message: 'Cannot assign completed tasks to user', data: null });
            }

            for (const t of tasks) {
                const oldOwnerId = t.assignedUser ? String(t.assignedUser) : '';
                if (oldOwnerId && oldOwnerId !== user._id.toString()) {
                    await User.updateOne(
                        { _id: oldOwnerId },
                        { $pull: { pendingTasks: t._id.toString() } }
                    );
                }
                t.assignedUser = user._id.toString();
                t.assignedUserName = user.name;
                await t.save();
            }

            user.pendingTasks = incoming;
            await user.save();
        }

        return res.status(201).json({ message: 'User created', data: user });
    } catch {
        return res.status(500).json({ message: 'Server Error while creating user', data: null });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';

        if (!name || !email) {
            return res.status(400).json({ message: 'name and email are required', data: null });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found', data: null });

        const existing = await User.findOne({ email, _id: { $ne: req.params.id } });
        if (existing) {
            return res.status(400).json({ message: 'A user with this email already exists', data: null });
        }

        const incomingPending = Array.isArray(req.body.pendingTasks)
            ? [...new Set(req.body.pendingTasks.map(String))]
            : user.pendingTasks.map(String);

        for (const id of incomingPending) {
            if (!isValidObjectId(id)) {
                return res.status(400).json({ message: 'Bad Request: pendingTasks contains invalid task id', data: null });
            }
        }

        const tasks = await Task.find({ _id: { $in: incomingPending } });
        if (tasks.length !== incomingPending.length) {
            return res.status(404).json({ message: 'One or more tasks in pendingTasks do not exist', data: null });
        }

        if (tasks.some(t => t.completed)) {
            return res.status(400).json({ message: 'Cannot add completed tasks to pendingTasks', data: null });
        }

        const prevPending = new Set(user.pendingTasks.map(String));
        const incomingSet = new Set(incomingPending);
        const toAssign = [...incomingSet].filter(id => !prevPending.has(id));
        const toUnassign = [...prevPending].filter(id => !incomingSet.has(id));

        if (toUnassign.length) {
            await Task.updateMany(
                { _id: { $in: toUnassign }, assignedUser: user._id.toString() },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
            );
        }

        if (toAssign.length) {
            const toAssignDocs = await Task.find({ _id: { $in: toAssign } });
            for (const t of toAssignDocs) {
                if (t.completed) {
                    return res.status(400).json({ message: 'Cannot assign completed tasks', data: null });
                }
                const oldOwnerId = t.assignedUser ? String(t.assignedUser) : '';
                if (oldOwnerId && oldOwnerId !== user._id.toString()) {
                    await User.updateOne(
                        { _id: oldOwnerId },
                        { $pull: { pendingTasks: t._id.toString() } }
                    );
                }
                t.assignedUser = user._id.toString();
                t.assignedUserName = name;
                await t.save();
            }
        }

        user.name = name;
        user.email = email;
        user.pendingTasks = incomingPending;
        await user.save();

        await Task.updateMany(
            { assignedUser: user._id.toString() },
            { $set: { assignedUserName: name } }
        );

        return res.status(200).json({ message: 'User updated', data: user });
    } catch (err) {
        const msg = err.name === 'CastError'
            ? 'Bad Request: invalid user id'
            : 'Server Error while updating user';
        const code = err.name === 'CastError' ? 400 : 500;
        return res.status(code).json({ message: msg, data: null });
    }
});

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
