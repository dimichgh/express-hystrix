'use strict';

const Assert = require('assert');

module.exports = function factory(config) {
    Assert.ok(config.runCommandFactory);
    return (command, req, res, next) => {
        return new Promise((resolve, reject) => {
            next();
            // simulate failure
            reject(new Error('Boom'));
        });
    };
};
