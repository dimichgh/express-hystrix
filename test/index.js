'use strict';

const Assert = require('assert');
const Http = require('http');

const Async = require('async');
const express = require('express');
const supertest = require('supertest');
const commandFactory = require('..');
const Hystrix = commandFactory.Hystrix;

describe(__filename, () => {
    afterEach(() => {
        Hystrix.commandFactory.resetCache();
        Hystrix.metricsFactory.resetCache();
        Hystrix.circuitFactory.resetCache();
    });

    it('should record command metrics', next => {
        const app = express();
        app.use(commandFactory());
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });

        supertest(app).get('/').end((err, res) => {
            Assert.ok(!err, err && err.stack);
            Assert.equal('ok', res.text);

            const metrics = Hystrix.metricsFactory.getOrCreate({commandKey:'/'});
            Assert.equal(1, metrics.getRollingCount('SUCCESS'));
            next();
        });
    });

    it('should use custom commandResolver', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return req.path === '/' ? 'home' : 'route';
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });

        Async.series([
            next => {
                supertest(app).get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(1, metricsHome.getRollingCount('SUCCESS'));

                    const metricsRoute = Hystrix.metricsFactory.getOrCreate({commandKey:'route'});
                    Assert.equal(0, metricsRoute.getRollingCount('SUCCESS'));

                    next();
                });
            },

            next => {
                supertest(app).get('/route').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(1, metricsHome.getRollingCount('SUCCESS'));

                    const metricsRoute = Hystrix.metricsFactory.getOrCreate({commandKey:'route'});
                    Assert.equal(1, metricsRoute.getRollingCount('SUCCESS'));

                    next();
                });
            }
        ], next);
    });

    it('should use commandStatusResolver to resolve command status', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return req.path === '/' ? 'home' : 'error';
            },
            commandStatusResolver: (req, res) => {
                // mock failure for route
                if (req.path === '/error') {
                    return Promise.reject(new Error('Boom'));
                }
                return Promise.resolve();
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });

        Async.series([
            next => {
                supertest(app).get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(1, metricsHome.getRollingCount('SUCCESS'));

                    const metricsRoute = Hystrix.metricsFactory.getOrCreate({commandKey:'error'});
                    Assert.equal(0, metricsRoute.getRollingCount('SUCCESS'));
                    Assert.equal(0, metricsRoute.getRollingCount('FAILURE'));

                    next();
                });
            },

            next => {
                supertest(app).get('/error').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(1, metricsHome.getRollingCount('SUCCESS'));

                    const metricsRoute = Hystrix.metricsFactory.getOrCreate({commandKey:'error'});
                    Assert.equal(0, metricsRoute.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsRoute.getRollingCount('FAILURE'));

                    next();
                });
            }
        ], next);
    });

    it('should record error, mark it down for next request with a subsequent fallback', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return 'home';
            },
            commandStatusResolver: (req, res) => {
                // mock failure for all requests
                return Promise.reject(new Error('Boom'));
            },
            hystrix: {
                default: {
                    circuitBreakerRequestVolumeThreshold: 1
                }
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });
        app.use((req, res, next) => {
            next(new Error('Should never happen'));
        });
        app.use((err, req, res, next) => {
            res.status(200).end('fallback');
        });

        const agent = supertest(app);

        Async.series([
            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('FALLBACK_SUCCESS'));
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('fallback', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('FALLBACK_SUCCESS'));
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(1, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            }
        ], next);
    });

    it('should handle browser connection reset', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return 'home';
            }
        }));
        app.use((req, res, next) => {
            setTimeout(() => {
                res.status(200).end('ok');
            }, 200);
        });

        let port;
        Async.series([
            next => {
                const session = app.listen(() => {
                    port = session.address().port;
                    next();
                });
            },

            next => {
                const req = Http.get(`http://localhost:${port}/`);
                req.on('error', () => {}); // skip it

                setTimeout(() => {
                    // break the connection
                    req.abort();
                    next();
                }, 100);
            },

            next => setTimeout(next, 100),

            next => {
                const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                Assert.equal(1, metricsHome.getRollingCount('SUCCESS'));
                Assert.equal(0, metricsHome.getRollingCount('FAILURE'));
                Assert.equal(0, metricsHome.getRollingCount('FALLBACK_SUCCESS'));

                next();
            }
        ], next);
    });

    it('should use load commandResolver and commandStatusResolver', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: require.resolve('./fixtures/command-resolver'),
            commandStatusResolver: require.resolve('./fixtures/command-status-resolver')
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });

        Async.series([
            next => {
                supertest(app).get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(1, metricsHome.getRollingCount('SUCCESS'));

                    const metricsRoute = Hystrix.metricsFactory.getOrCreate({commandKey:'error'});
                    Assert.equal(0, metricsRoute.getRollingCount('SUCCESS'));
                    Assert.equal(0, metricsRoute.getRollingCount('FAILURE'));

                    next();
                });
            },

            next => {
                supertest(app).get('/error').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(1, metricsHome.getRollingCount('SUCCESS'));

                    const metricsRoute = Hystrix.metricsFactory.getOrCreate({commandKey:'error'});
                    Assert.equal(0, metricsRoute.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsRoute.getRollingCount('FAILURE'));

                    next();
                });
            }
        ], next);
    });

    it('should use custom config if available', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return req.path === '/' ? 'home' : 'other';
            },
            commandStatusResolver: (req, res) => {
                // mock failure for all requests
                return Promise.reject(new Error('Boom'));
            },
            hystrix: {
                other: {
                    circuitBreakerRequestVolumeThreshold: 1
                }
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });
        app.use((req, res, next) => {
            next(new Error('Should never happen'));
        });
        app.use((err, req, res, next) => {
            res.status(200).end('fallback');
        });

        const agent = supertest(app);

        Async.series([
            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));
                    Assert.equal(1, metricsHome.getRollingCount('FALLBACK_FAILURE'));

                    next();
                });
            },

            next => {
                agent.get('/other').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'other'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));
                    Assert.equal(1, metricsHome.getRollingCount('FALLBACK_FAILURE'));

                    next();
                });
            },

            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));
                    Assert.equal(2, metricsHome.getRollingCount('FALLBACK_FAILURE'));

                    next();
                });
            },

            next => {
                agent.get('/other').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('fallback', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'other'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(1, metricsHome.getRollingCount('SHORT_CIRCUITED'));
                    Assert.equal(0, metricsHome.getRollingCount('FALLBACK_SUCCESS'));
                    // it is still failure as open circuit does not increment fallback
                    // even when fallback is performed
                    Assert.equal(1, metricsHome.getRollingCount('FALLBACK_FAILURE'));

                    next();
                });
            }
        ], next);
    });

    it('should use custom command runner if available', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return req.path === '/' ? 'home' : 'other';
            },
            runCommand: (command, req, res, next) => {
                return new Promise((resolve, reject) => {
                    next();
                    // simulate failure
                    reject(new Error('Boom'));
                });
            },
            hystrix: {
                other: {
                    circuitBreakerRequestVolumeThreshold: 1
                }
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });
        app.use((req, res, next) => {
            next(new Error('Should never happen'));
        });
        app.use((err, req, res, next) => {
            res.status(200).end('fallback');
        });

        const agent = supertest(app);

        Async.series([
            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                agent.get('/other').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'other'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                agent.get('/other').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('fallback', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'other'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(1, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            }
        ], next);
    });

    it('should use custom fallback if available', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return req.path === '/' ? 'home' : 'other';
            },
            runCommand: (command, req, res, next) => {
                return new Promise((resolve, reject) => {
                    next();
                    // simulate failure
                    reject(new Error('Boom'));
                });
            },
            fallback: (err, command, req, res, next) => {
                return Promise.resolve(); // mark as FALLBACK_SUCCESS
            },
            hystrix: {
                other: {
                    circuitBreakerRequestVolumeThreshold: 1
                }
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });
        app.use((req, res, next) => {
            next(new Error('Should never happen'));
        });
        app.use((err, req, res, next) => {
            res.status(200).end('fallback');
        });

        const agent = supertest(app);

        Async.series([
            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                // validate fallback success
                const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                Assert.equal(2, metricsHome.getRollingCount('FALLBACK_SUCCESS'));
                Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                next();
            }
        ], next);
    });

    it('should use custom fallback and command runner as string args', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return req.path === '/' ? 'home' : 'other';
            },
            runCommand: require.resolve('./fixtures/run-command'),
            fallback: require.resolve('./fixtures/fallback'),
            hystrix: {
                other: {
                    circuitBreakerRequestVolumeThreshold: 1
                }
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });
        app.use((req, res, next) => {
            next(new Error('Should never happen'));
        });
        app.use((err, req, res, next) => {
            res.status(200).end('fallback');
        });

        const agent = supertest(app);

        Async.series([
            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                // validate fallback success
                const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                Assert.equal(2, metricsHome.getRollingCount('FALLBACK_SUCCESS'));
                Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                next();
            }
        ], next);
    });

    it('should use custom fallback and command runner factory as string args', next => {
        const app = express();
        app.use(commandFactory({
            commandResolver: req => {
                return req.path === '/' ? 'home' : 'other';
            },
            commandExecutorFactory: require.resolve('./fixtures/run-command-factory'),
            fallback: require.resolve('./fixtures/fallback'),
            hystrix: {
                other: {
                    circuitBreakerRequestVolumeThreshold: 1
                }
            }
        }));
        app.use((req, res, next) => {
            res.status(200).end('ok');
        });
        app.use((req, res, next) => {
            next(new Error('Should never happen'));
        });
        app.use((err, req, res, next) => {
            res.status(200).end('fallback');
        });

        const agent = supertest(app);

        Async.series([
            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(1, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                agent.get('/').end((err, res) => {
                    Assert.ok(!err, err && err.stack);
                    Assert.equal('ok', res.text);

                    const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                    Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                    Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                    Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                    next();
                });
            },

            next => {
                // validate fallback success
                const metricsHome = Hystrix.metricsFactory.getOrCreate({commandKey:'home'});
                Assert.equal(0, metricsHome.getRollingCount('SUCCESS'));
                Assert.equal(2, metricsHome.getRollingCount('FAILURE'));
                Assert.equal(2, metricsHome.getRollingCount('FALLBACK_SUCCESS'));
                Assert.equal(0, metricsHome.getRollingCount('SHORT_CIRCUITED'));

                next();
            }
        ], next);
    });
});
