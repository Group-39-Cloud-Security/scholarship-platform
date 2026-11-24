// audit.js — writeAudit(): business and security events into the AuditLog table
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §5, §7, §10
//
// Use in a controller, after the action succeeded:
//   await writeAudit({ action: 'decision', userId: req.user.userId, targetId: applicationId, detail: 'accepted' });
// detail is a short description: never secrets, tokens, passwords, essays or request bodies.

const crypto = require('crypto');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('./dynamo');
const { log } = require('./logger');

async function writeAudit({ action, userId, targetId, detail }) {
  const createdAt = new Date().toISOString();
  const sortKey = `${createdAt}#${crypto.randomUUID()}`; // §5: time order within an action, unique even in the same ms
  try {
    await docClient.send(new PutCommand({
      TableName: process.env.AUDIT_TABLE,
      Item: { action, sortKey, userId, targetId, detail },
    }));
  } catch (err) {
    // A failed audit write must never break the request; it still shows up in CloudWatch.
    log('error', 'audit write failed', { action, userId, targetId, error: err.name });
  }
}

module.exports = { writeAudit };
