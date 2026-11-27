// userAdminService.js — Users table: list, create reviewer, disable/enable (AWS calls only, never req/res)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §5 (Users), §6 Accounts, §7 (admin-service-role)
//
// passwordHash is written on create and NEVER read back: every read names its fields in a ProjectionExpression.

const { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const TABLE = process.env.USERS_TABLE;
const SAFE_FIELDS = 'userId, email, #n, #r, #s, mustChangePassword, createdAt';
const SAFE_NAMES = { '#n': 'name', '#r': 'role', '#s': 'status' }; // reserved words in DynamoDB
const isConditionFail = (err) => err.name === 'ConditionalCheckFailedException';

// All users, optionally only one role and/or status. Users has no role index, so this is a paged Scan.
async function listUsers({ role, status }) {
  const filters = [];
  const values = {};
  if (role) { filters.push('#r = :role'); values[':role'] = role; }
  if (status) { filters.push('#s = :status'); values[':status'] = status; }
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: SAFE_FIELDS,
      ExpressionAttributeNames: SAFE_NAMES,
      ...(filters.length ? { FilterExpression: filters.join(' AND '), ExpressionAttributeValues: values } : {}),
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getUser(userId) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE, Key: { userId }, ProjectionExpression: SAFE_FIELDS, ExpressionAttributeNames: SAFE_NAMES,
  }));
  return res.Item || null;
}

// Is this email already used? (email-index). Not atomic: see the note in docs/decisions.md.
async function emailTaken(email) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE, IndexName: 'email-index', KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email }, Select: 'COUNT',
  }));
  return res.Count > 0;
}

// New user. attribute_not_exists: never overwrites an existing account.
async function createUser(user) {
  await docClient.send(new PutCommand({
    TableName: TABLE, Item: user, ConditionExpression: 'attribute_not_exists(userId)',
  }));
}

// from → to for a non-admin target (or any enable). One conditional update.
async function setStatus(userId, from, to) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { userId },
      UpdateExpression: 'SET #s = :to',
      ConditionExpression: 'attribute_exists(userId) AND #s = :from',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':to': to, ':from': from },
    }));
    return 'ok';
  } catch (err) {
    if (isConditionFail(err)) return 'target';
    throw err;
  }
}

// Disable an ADMIN, atomically with a check that the acting admin is still an active admin (§6: never the last
// active admin). Both happen in one transaction: if two admins disable each other at the same time, DynamoDB
// runs one transaction after the other, the second one's ConditionCheck fails, and one admin always stays active.
// Returns 'ok', 'target' (target no longer active), 'actor' (acting admin not an active admin) or 'conflict'.
async function disableAdmin(targetId, actorId) {
  try {
    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        { Update: {
          TableName: TABLE,
          Key: { userId: targetId },
          UpdateExpression: 'SET #s = :disabled',
          ConditionExpression: 'attribute_exists(userId) AND #s = :active',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':disabled': 'disabled', ':active': 'active' },
        } },
        { ConditionCheck: {
          TableName: TABLE,
          Key: { userId: actorId },
          ConditionExpression: '#r = :admin AND #s = :active',
          ExpressionAttributeNames: { '#r': 'role', '#s': 'status' },
          ExpressionAttributeValues: { ':admin': 'admin', ':active': 'active' },
        } },
      ],
    }));
    return 'ok';
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err;
    const codes = (err.CancellationReasons || []).map((r) => r && r.Code);
    if (codes[1] === 'ConditionalCheckFailed') return 'actor';
    if (codes[0] === 'ConditionalCheckFailed') return 'target';
    return 'conflict'; // e.g. TransactionConflict: another transaction touched the same users at that moment
  }
}

module.exports = { listUsers, getUser, emailTaken, createUser, setStatus, disableAdmin };
