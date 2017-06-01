'use strict';

module.exports = function (req) {
    return req.path === '/' ? 'home' : 'error';
};
