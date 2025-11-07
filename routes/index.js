/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app) {
    app.use('/api', require('./home.js'));
    app.use('/api/users', require('./users.js'));
    app.use('/api/tasks', require('./tasks.js'));
};
