const util = require('util');
const got = require('got');
const Joi = require('joi');
const isUrl = require('is-url');
const Boom = require('boom');
const repositoryUrl = require('../utils/repository-url');
const xpathHelper = require('../utils/xpath-helper');
const insight = require('../utils/insight.js');
const registryConfig = require('../../config.json');

function notFoundResponse() {
  return Boom.notFound('Package not found', {
    eventKey: 'package_not_found',
  });
}

function parseFailedResponse() {
  return Boom.create(500, 'Parsing response failed', {
    eventKey: 'json_parse_failed',
  });
}

function repositoryUrlNotFoundResponse() {
  return Boom.create(500, 'Repository url not found', {
    eventKey: 'repository_url_not_found',
  });
}

function doRequest(packageName, type, cb) {
  const config = registryConfig[type];

  const requestUrl = util.format(config.registry, packageName.replace(/\//g, '%2f'));

  got.get(requestUrl).then((response) => {
    let json;

    try {
      json = JSON.parse(response.body);
    } catch (err) {
      return cb(parseFailedResponse());
    }

    const bestMatchUrl = xpathHelper(json, config.xpaths);
    let url = repositoryUrl(bestMatchUrl);

    if (!url && isUrl(bestMatchUrl)) {
      url = bestMatchUrl;
    }

    if (!url && config.fallback) {
      url = util.format(config.fallback, packageName);
    }

    if (!url) {
      return cb(repositoryUrlNotFoundResponse());
    }

    got.get(url).then(() => {
      cb(null, url);
    }).catch(() => {
      url = util.format(config.fallback, packageName);
      cb(null, url);
    });
  }, (err) => {
    if (err.code === 404) {
      return cb(notFoundResponse());
    }

    return cb(Boom.wrap(err));
  });
}

exports.register = (server, options, next) => {
  server.route([{
    path: '/q/{registry}/{package*}',
    method: 'GET',
    config: {
      validate: {
        params: {
          registry: Joi.required().valid(Object.keys(registryConfig)),
          package: Joi.required(),
        },
      },
      handler: (request, reply) => {
        const pkg = request.params.package;
        const type = request.params.registry;
        const eventData = {
          registry: type,
          package: pkg,
          referer: request.headers.referer,
        };

        doRequest(pkg, type, (err, url) => {
          if (err) {
            const eventKey = (err.data || {}).eventKey;
            insight.trackError(eventKey, err, eventData, request);
            return reply(err);
          }

          eventData.url = url;
          insight.trackEvent('resolved', eventData, request);

          reply({
            url,
          });
        });
      },
    },
  }]);

  next();
};

exports.register.attributes = {
  pkg: {
    name: 'Universal Resolver',
    version: '1.0.0',
  },
};
