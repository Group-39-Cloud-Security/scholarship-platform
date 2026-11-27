// userService.js — Users table access (AWS calls only, never req/res)
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §5 (Users), §7 (auth-service-role)
//
// passwordHash is only ever read by findByEmail (login). Nothing in this service returns it to a client.

const { PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = process.env.USERS_TABLE;

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

// New user. attribute_not_exists: never overwrites an existing account.
async function createUser(user) {
  await docClient.send(new PutCommand({
    TableName: TABLE, Item: user, ConditionExpression: 'attribute_not_exists(userId)',
  }));
}

module.exports = { emailTaken, findByEmail, createUser };
