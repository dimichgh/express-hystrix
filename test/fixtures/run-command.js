'use strict';

module.exports = (command, req, res, next) => {
    return new Promise((resolve, reject) => {
        next();
        // simulate failure
        reject(new Error('Boom'));
    });
};
