'use strict';

const Hystrix = require('hystrixjs');
const Hoek = require('hoek');
const commandFactory = Hystrix.commandFactory;

const GROUP = 'express:hystrix:data';

module.exports = function hystrixFactory(config) {
    config = config || {};

    if (config.commandResolver && typeof config.commandResolver === 'string') {
        config.commandResolver = require(config.commandResolver);
    }

    if (config.commandStatusResolver && typeof config.commandStatusResolver === 'string') {
        config.commandStatusResolver = require(config.commandStatusResolver);
    }

    return function hystrix(req, res, next) {
        const command = config.commandResolver && config.commandResolver(req) || req.path;

        const commandBuilder = commandFactory.getOrCreate(command, GROUP)
        .run(function run(req, res, next) {
            return new Promise((resolve, reject) => {
                const handleResponseStatus = Hoek.once(function handleResponseStatus() {
                    if (config.commandStatusResolver) {
                        // hook to custom command status resolver
                        return config.commandStatusResolver(req, res)
                        .then(resolve)
                        .catch(reject);
                    }
                    resolve();
                });

                res.once('finish', handleResponseStatus);
                res.once('close', handleResponseStatus);
                next();
            });
        });

        // check if config has a specific hystrix config for the current command
        if (config.hystrix) {
            if (config.hystrix['default']) {
                // configure default if available
                Object.assign(commandBuilder.config, config.hystrix['default']);
            }

            if (config.hystrix[command]) {
                // configure command specific if available
                Object.assign(commandBuilder.config, config.hystrix[command]);
            }
        }

        commandBuilder
        .fallbackTo((err, args) => {
            const next = args.pop();
            const res = args.pop();
            if (res.finished) {
                return Promise.reject(err);
            }
            next(err);
        })
        .build()
        .execute(req, res, next)
        .catch(err => {
            // skip it
        });
    };
};

module.exports.Hystrix = Hystrix;
