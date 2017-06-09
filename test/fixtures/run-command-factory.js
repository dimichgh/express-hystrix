'use strict';

const Assert = require('assert');

module.exports = function factory(config) {
    Assert.ok(config.commandExecutorFactory);
    return (command, req, res, next) => {
        return new Promise((resolve, reject) => {
            setImmediate(next);
            // simulate failure
            reject(new Error('Boom'));
        });
    };
};
