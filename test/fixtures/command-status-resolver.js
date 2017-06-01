'use strict';

module.exports = (req, res) => {
    // mock failure for route
    if (req.path === '/error') {
        return Promise.reject(new Error('Boom'));
    }
    return Promise.resolve();
};
