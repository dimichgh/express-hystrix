# express-hystrix

The module provides a middleware that wraps every http incoming request into a hystrix command that provides fail fast behavior as well as exposes metrics for every express route.

[![codecov](https://codecov.io/gh/dimichgh/express-hystrix/branch/master/graph/badge.svg)](https://codecov.io/gh/dimichgh/express-hystrix)
[![Build Status](https://travis-ci.org/dimichgh/express-hystrix.svg?branch=master)](https://travis-ci.org/dimichgh/express-hystrix) [![NPM](https://img.shields.io/npm/v/express-hystrix.svg)](https://www.npmjs.com/package/express-hystrix)
[![Downloads](https://img.shields.io/npm/dm/express-hystrix.svg)](http://npm-stat.com/charts.html?package=express-hystrix)
[![Known Vulnerabilities](https://snyk.io/test/github/dimichgh/express-hystrix/badge.svg)](https://snyk.io/test/github/dimichgh/express-hystrix)

### Install

```
$ npm install express-hystrix -S
```

### Usage

### Configuration

#### Hystrix configuration

The module allows to provide default hystrix configuration for all command as well as customize configuration for specific command.

##### Default configuration

```js
const app = express();
const commandFactory = require('express-hystrix');

app.use(commandFactory({
    hystrix: {
        default: {
            circuitBreakerErrorThresholdPercentage: 50,
            circuitBreakerForceClosed: false,
            circuitBreakerForceOpened: false,
            circuitBreakerRequestVolumeThreshold: 20,
            circuitBreakerSleepWindowInMilliseconds: 5000,
            requestVolumeRejectionThreshold: 0,
            statisticalWindowNumberOfBuckets: 10,
            statisticalWindowLength: 10000,
            percentileWindowNumberOfBuckets: 6,
            percentileWindowLength: 60000
        }
    }
}));
```

##### Command specific hystrix configuration

```js
const app = express();
const commandFactory = require('express-hystrix');

app.use(commandFactory({
    hystrix: {
        default: {
            circuitBreakerErrorThresholdPercentage: 50,
            circuitBreakerForceClosed: false,
            circuitBreakerForceOpened: false,
        },
        listCommand: {
            circuitBreakerRequestVolumeThreshold: 20,
            circuitBreakerSleepWindowInMilliseconds: 5000,
            requestVolumeRejectionThreshold: 0,
        },
        postCommand: {
            circuitBreakerRequestVolumeThreshold: 2
        }
    }
}));
```

__NOTE__ One needs to specify only config parameters that are different from the ones provided in default settings

#### Resolving hystrix command

By default the module will use req.path as a command name which may not be what developers would like to use.
In such a case the module allows to customize a resolution command which can be mapped to the given route or routes.

```js
const app = express();
const commandFactory = require('express-hystrix');

app.use(commandFactory({
    commandResolver: req => {
        return req.path === '/' ? 'home' : 'error';
    }
}));
```

#### Resolving command state

Since most of the time there is no error that would trigger edge case event for circuit breaker, the module provides a way to resolve command status based on response core as well as request metadata which may affect future circuit state for the given command.

```js
const app = express();
const commandFactory = require('express-hystrix');

app.use(commandFactory({
    commandStatusResolver: (err, req, res) => {
        if (res.statusCode === 404) {
            Promise.reject(new Error('Bad path'));
        }
        // mock failure for all requests
        return Promise.resolve();
    }
}));
```

#### Hystrix fallback

Even though the module is based on hystrix the fallback functionality is not directly customizable due to the nature of reacting by circuit breaker to the state of request/response flow after it is already sent back to the client partially or in full. The hystrix is used to record events to be able to react to subsequent events of the same nature (handling same route/request.)

There are two use cases:
* Reacting to the response that has been already written to the output. Here we just record metrics and events.
* Reacting to open circuit event in which case the fallback would call next(err) which will give an opportunity to the developer to provide a fallback option.

```js
const app = express();
const commandFactory = require('express-hystrix');

app.use(commandFactory({
    commandStatusResolver: (err, req, res) => {
        if (res.statusCode === 404) {
            Promise.reject(new Error('Bad path'));
        }
        // mock failure for all requests
        return Promise.resolve();
    }
}));
// handle open circuit event
app.use((err, res, res, next) => {
    if (err && err.message === 'OpenCircuitError') {
        res.status(500).end('Circuit is open');
        return;
    }
    // continue to the next error handler
    next(err);
});
```
