// tokenService.js — signs the login JWT with the secret from SSM (AWS call only)
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §2 (JWT HS256, 1 hour), §4, §10
//
// The secret is read from SSM (/scholarship/jwt-secret, SecureString) once per Lambda container and kept in memory;
// it is never in code, env vars or logs.

const jwt = require('jsonwebtoken');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient({});
let secretPromise = null;

function getSecret() {
  if (!secretPromise) {
    secretPromise = ssm.send(new GetParameterCommand({ Name: process.env.JWT_SECRET_PARAM, WithDecryption: true }))
      .then((res) => res.Parameter.Value)
      .catch((err) => { secretPromise = null; throw err; }); // retry on the next request instead of caching a failure
  }
  return secretPromise;
}

// sub = userId. The role is in the token only for the frontend; the backend re-reads role and status from Users.
async function signToken(user) {
  return jwt.sign({ sub: user.userId, role: user.role }, await getSecret(), { algorithm: 'HS256', expiresIn: '1h' });
}

module.exports = { signToken };
