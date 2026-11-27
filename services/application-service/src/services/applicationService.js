// applicationService.js — the Applications table: create, read, list by student, conditional delete.
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §5, §6 (status flow), §7
// Service layer: AWS calls only, never sees req/res. Business rules live in the controller.

const { PutCommand, GetCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');

const table = () => process.env.APPLICATIONS_TABLE;

// New application. The condition makes sure we never overwrite an existing item, even if two ids collided.
async function createApplication(item) {
  await docClient.send(new PutCommand({
    TableName: table(),
    Item: item,
    ConditionExpression: 'attribute_not_exists(applicationId)',
  }));
  return item;
}

async function getApplication(applicationId) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: table(),
    Key: { applicationId },
  }));
  return Item || null;
}

// All applications of one student, using studentId-index (no table scan).
async function listByStudent(studentId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await docClient.send(new QueryCommand({
      TableName: table(),
      IndexName: 'studentId-index',
      KeyConditionExpression: 'studentId = :me',
      ExpressionAttributeValues: { ':me': studentId },
      ExclusiveStartKey,
    }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Withdraw = delete, but ONLY if the item still belongs to this student AND is still "submitted".
// Both are checked by DynamoDB in the same write (ConditionExpression), so a reviewer claiming the
// application at the same moment can't slip in between our read and our delete (§6: one conditional update per transition).
// Returns true if deleted, false if the condition failed (the controller turns that into 409).
async function deleteIfSubmitted(applicationId, studentId) {
  try {
    await docClient.send(new DeleteCommand({
      TableName: table(),
      Key: { applicationId },
      ConditionExpression: 'studentId = :me AND #s = :submitted',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':me': studentId, ':submitted': 'submitted' },
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

module.exports = { createApplication, getApplication, listByStudent, deleteIfSubmitted };
