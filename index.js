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

    if (config.fallback && typeof config.fallback === 'string') {
        config.fallback = require(config.fallback);
    }

    if (config.runCommand && typeof config.runCommand === 'string') {
        config.runCommand = require(config.runCommand);
    }

    let runCommand = config.runCommand || defaultRunCommand;

    return function hystrix(req, res, next) {
        const command = config.commandResolver && config.commandResolver(req) || req.path;

        const commandBuilder = commandFactory.getOrCreate(command, GROUP)
        .run(runCommand);

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

        // default fallback
        let fallback = (err, args) => {
            const next = args.pop();
            const res = args.pop();
            return new Promise((resolve, reject) => {
                if (res.finished) {
                    return reject(err);
                }
                next(err);
                resolve();
            });
        };

        // custom fallback
        if (config.fallback) {
            fallback = (err, args) => {
                // fallback(err, command, req, res, next)
                return config.fallback(err, args.shift(), args.shift(), args.shift(), args.shift());
            };
        }

        commandBuilder
        .fallbackTo(fallback)
        .build()
        .execute(command, req, res, next)
        .catch(err => {
            // skip it
        });
    };

    function defaultRunCommand(command, req, res, next) {
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
    }
};

module.exports.Hystrix = Hystrix;
