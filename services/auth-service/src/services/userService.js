// userService.js — Users table access (AWS calls only, never req/res)
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §5 (Users), §7 (auth-service-role)
//
// passwordHash is only read to check a password (findByEmail, getPasswordHash). Nothing here returns it to a client.

const { GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = process.env.USERS_TABLE;
const SAFE_FIELDS = 'userId, email, #n, #r, #s, mustChangePassword, createdAt';
const SAFE_NAMES = { '#n': 'name', '#r': 'role', '#s': 'status' }; // reserved words in DynamoDB
const isConditionFail = (err) => err.name === 'ConditionalCheckFailedException';

// Is this email already used? (email-index). Not atomic: same limit as admin-service, see docs/decisions.md.
async function emailTaken(email) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE, IndexName: 'email-index', KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email }, Select: 'COUNT',
  }));
  return res.Count > 0;
}

// The whole account by email, passwordHash included: only for checking a password, never sent to a client.
async function findByEmail(email) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE, IndexName: 'email-index', KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email },
  }));
  return (res.Items || [])[0] || null;
}

// The account without passwordHash (GET /me).
async function getUser(userId) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE, Key: { userId }, ProjectionExpression: SAFE_FIELDS, ExpressionAttributeNames: SAFE_NAMES,
  }));
  return res.Item || null;
}

// Only the hash, for checking the current password on a password change.
async function getPasswordHash(userId) {
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: { userId }, ProjectionExpression: 'passwordHash' }));
  return res.Item ? res.Item.passwordHash : null;
}

// New user. attribute_not_exists: never overwrites an existing account.
async function createUser(user) {
  await docClient.send(new PutCommand({
    TableName: TABLE, Item: user, ConditionExpression: 'attribute_not_exists(userId)',
  }));
}

// Replace the hash and clear mustChangePassword, only if the account is still active and the hash is still the one
// that was checked (two changes at once: the second fails instead of silently overwriting). false = condition failed.
async function setPassword(userId, checkedHash, newHash) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { userId },
      UpdateExpression: 'SET passwordHash = :new, mustChangePassword = :false',
      ConditionExpression: 'attribute_exists(userId) AND #s = :active AND passwordHash = :checked',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':new': newHash, ':false': false, ':active': 'active', ':checked': checkedHash },
    }));
    return true;
  } catch (err) {
    if (isConditionFail(err)) return false;
    throw err;
  }
}

module.exports = { emailTaken, findByEmail, getUser, getPasswordHash, createUser, setPassword };
