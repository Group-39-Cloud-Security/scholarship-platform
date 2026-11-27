// loginAttemptService.js — LoginAttempts table: failed-login backoff per email + source IP (AWS calls only)
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §5 (LoginAttempts), §6 Accounts and login
//
// No account lockout (Seif: anyone could lock out an admin). Failures are counted per "<email>#<ip>", so an attacker
// on one IP never blocks the real user on another. After 5 failures that pair is blocked for 1 min, doubling with
// every further failure up to 15 min. A success resets the count. DynamoDB TTL deletes rows 24 h after the last failure.

const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = process.env.LOGIN_ATTEMPTS_TABLE;
const FREE_FAILURES = 5;
const FIRST_BLOCK_MS = 60 * 1000;
const MAX_BLOCK_MS = 15 * 60 * 1000;
const KEEP_SECONDS = 24 * 60 * 60;

const keyOf = (email, ip) => `${email}#${ip}`;

// Block length after `failures` failures: 0 for the first 4, then 1, 2, 4, 8, 15, 15... minutes.
function blockMs(failures) {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(FIRST_BLOCK_MS * 2 ** (failures - FREE_FAILURES), MAX_BLOCK_MS);
}

async function getAttempt(email, ip) {
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: { emailIp: keyOf(email, ip) } }));
  return res.Item || null;
}

// One failure more. ADD is atomic, so parallel wrong guesses are all counted. Returns the new count.
async function recordFailure(email, ip, now = Date.now()) {
  const res = await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { emailIp: keyOf(email, ip) },
    UpdateExpression: 'ADD failures :one SET expiresAt = :exp',
    ExpressionAttributeValues: { ':one': 1, ':exp': Math.floor(now / 1000) + KEEP_SECONDS },
    ReturnValues: 'UPDATED_NEW',
  }));
  const failures = res.Attributes.failures;
  const ms = blockMs(failures);
  if (ms > 0) {
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { emailIp: keyOf(email, ip) },
      UpdateExpression: 'SET blockedUntil = :until',
      ExpressionAttributeValues: { ':until': new Date(now + ms).toISOString() },
    }));
  }
  return failures;
}

// Successful login: start counting from zero again.
async function reset(email, ip) {
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { emailIp: keyOf(email, ip) },
    UpdateExpression: 'SET failures = :zero REMOVE blockedUntil',
    ExpressionAttributeValues: { ':zero': 0 },
  }));
}

module.exports = { getAttempt, recordFailure, reset, blockMs };
