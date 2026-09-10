'use strict';

const crypto = require('crypto');

function requestToken(req) {
  const header = String(req && typeof req.get === 'function' ? req.get('authorization') : '').replace(/^Bearer\s+/i, '').trim();
  return header || String(req && req.body && req.body.token || req && req.query && req.query.token || '').trim();
}

function authorizationToken(req) {
  return String(req && typeof req.get === 'function' ? req.get('authorization') : '').replace(/^Bearer\s+/i, '').trim();
}

function tokenMatches(expectedValue, suppliedValue) {
  const expected = Buffer.from(String(expectedValue || ''));
  const supplied = Buffer.from(String(suppliedValue || ''));
  return expected.length > 0 && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function requestMatchesToken(req, expectedValue) {
  return tokenMatches(expectedValue, requestToken(req));
}

function authorizationMatchesToken(req, expectedValue) {
  return tokenMatches(expectedValue, authorizationToken(req));
}

module.exports = { authorizationMatchesToken, requestMatchesToken, requestToken, tokenMatches };
