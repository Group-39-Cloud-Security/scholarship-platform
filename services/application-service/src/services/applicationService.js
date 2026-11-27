// applicationService.js — the Applications table: atomic create (with its limits), read, list by student, atomic withdraw.
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §5, §6 (status flow), §7
// Service layer: AWS calls only, never sees req/res. The controller turns the results into status codes.
//
// WHY LOCK ROWS: "one application per scholarship" and "at most 3 active" can't be enforced by reading first and
// writing after: two requests at the same moment both read "OK" and both write. So every apply is ONE
// TransactWriteItems that also writes small lock rows with conditions; DynamoDB lets exactly one of two clashing
// requests through. The lock rows live in this same table (no new table) and only have
// applicationId (the key), lockType, holder and createdAt. Without studentId/scholarshipId/status/submittedAt they
// never appear in studentId-index, scholarshipId-index or status-index, so the other services never see them.
//   lock#one#<studentId>#<scholarshipId>   one per student and scholarship, holder = the application
//   lock#slot#<studentId>#<1|2|3>           3 slots per student, holder = an application using it
// A slot whose holder is accepted, rejected or gone counts as free. That is checked INSIDE the transaction
// (ConditionCheck on the holder), so admin-service's decisions free slots without knowing they exist.

const crypto = require('crypto');
const {
  GetCommand, QueryCommand, TransactWriteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../../shared/dynamo');
const { MAX_ACTIVE_APPLICATIONS } = require('./eligibility');

const table = () => process.env.APPLICATIONS_TABLE;
const FINAL = ['accepted', 'rejected'];
const MAX_ATTEMPTS = 3; // a clash on a slot is retried with fresh reads (two requests may race for the same free slot)

const oneKey = (studentId, scholarshipId) => `lock#one#${studentId}#${scholarshipId}`;
const slotKey = (studentId, n) => `lock#slot#${studentId}#${n}`;
const slotNumbers = () => Array.from({ length: MAX_ACTIVE_APPLICATIONS }, (_, i) => i + 1);

// Strongly consistent read: lock decisions must not use a stale copy.
async function getItem(applicationId) {
  const { Item } = await docClient.send(new GetCommand({
    TableName: table(), Key: { applicationId }, ConsistentRead: true,
  }));
  return Item || null;
}

async function getApplication(applicationId) {
  return getItem(applicationId);
}

// All applications of one student, using studentId-index (no table scan). Lock rows are never in this index.
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

// Reads the locks and decides what this apply must claim. Returns
//   { alreadyApplied: true } | { limitReached: true } | { marker, slot } where each is { key, oldHolder }.
async function planLocks(studentId, scholarshipId) {
  // One per scholarship: taken unless its holder application no longer exists (withdrawn or removed).
  const marker = await getItem(oneKey(studentId, scholarshipId));
  let markerPlan = { key: oneKey(studentId, scholarshipId), oldHolder: null, holderGone: false };
  if (marker) {
    if (await getItem(marker.holder)) return { alreadyApplied: true };
    markerPlan = { ...markerPlan, oldHolder: marker.holder, holderGone: true };
  }

  // Max active: the first empty slot, else the first slot whose holder is final or gone.
  const slots = await Promise.all(slotNumbers().map(async (n) => ({ n, item: await getItem(slotKey(studentId, n)) })));
  const empty = slots.find((s) => !s.item);
  if (empty) return { marker: markerPlan, slot: { key: slotKey(studentId, empty.n), oldHolder: null, holderGone: false } };
  for (const s of slots) {
    const holder = await getItem(s.item.holder);
    if (!holder || FINAL.includes(holder.status)) {
      return { marker: markerPlan, slot: { key: slotKey(studentId, s.n), oldHolder: s.item.holder, holderGone: !holder } };
    }
  }
  return { limitReached: true };
}

function lockPut(lock, lockType, applicationId, now) {
  return {
    Put: {
      TableName: table(),
      Item: { applicationId: lock.key, lockType, holder: applicationId, createdAt: now },
      // Claim an empty lock, or take over exactly the holder we read (if it changed meanwhile, we lose the race).
      ConditionExpression: lock.oldHolder ? 'holder = :old' : 'attribute_not_exists(applicationId)',
      ...(lock.oldHolder ? { ExpressionAttributeValues: { ':old': lock.oldHolder } } : {}),
    },
  };
}

// Creates the application and claims its locks in ONE transaction.
// Returns { ok: true } | { alreadyApplied: true } | { limitReached: true } | { busy: true }.
async function createApplicationAtomic(item) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const plan = await planLocks(item.studentId, item.scholarshipId);
    if (!plan.marker) return plan; // alreadyApplied or limitReached

    const now = new Date().toISOString();
    const actions = [
      { Put: { TableName: table(), Item: item, ConditionExpression: 'attribute_not_exists(applicationId)' } },
      lockPut(plan.marker, 'one-per-scholarship', item.applicationId, now),
      lockPut(plan.slot, 'active-slot', item.applicationId, now),
    ];
    // Taking over a lock: re-check its old holder inside the transaction. One check per item
    // (a transaction can't touch the same item twice); "gone" is the stricter rule, so it wins.
    const checks = new Map();
    if (plan.slot.oldHolder) {
      checks.set(plan.slot.oldHolder, plan.slot.holderGone ? 'gone' : 'gone-or-final');
    }
    if (plan.marker.oldHolder) checks.set(plan.marker.oldHolder, 'gone');
    for (const [holderId, rule] of checks) {
      actions.push({
        ConditionCheck: {
          TableName: table(),
          Key: { applicationId: holderId },
          ConditionExpression: rule === 'gone'
            ? 'attribute_not_exists(applicationId)'
            : 'attribute_not_exists(applicationId) OR #s IN (:accepted, :rejected)',
          ...(rule === 'gone' ? {} : {
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':accepted': 'accepted', ':rejected': 'rejected' },
          }),
        },
      });
    }

    try {
      await docClient.send(new TransactWriteCommand({
        TransactItems: actions,
        ClientRequestToken: crypto.randomUUID(), // idempotent if the SDK retries this exact call
      }));
      return { ok: true };
    } catch (err) {
      // Another request changed a lock between our read and our write. Read again and decide again.
      if (err.name !== 'TransactionCanceledException' && err.name !== 'TransactionConflictException') throw err;
    }
  }
  // Still clashing after fresh reads: report what the locks say now, or that it is busy.
  const plan = await planLocks(item.studentId, item.scholarshipId);
  return plan.marker ? { busy: true } : plan;
}

// Withdraw = delete the application (only if it is still this student's and still "submitted")
// AND release its marker and slot, all in ONE transaction. A reviewer claiming it at the same moment
// makes the condition fail, and nothing is deleted.
// Returns true if withdrawn, false if the application was no longer withdrawable (the controller answers 409).
async function withdrawAtomic(application) {
  const { applicationId, studentId, scholarshipId } = application;
  const slots = await Promise.all(slotNumbers().map((n) => getItem(slotKey(studentId, n))));
  const mySlot = slots.find((s) => s && s.holder === applicationId);

  const actions = [
    {
      Delete: {
        TableName: table(),
        Key: { applicationId },
        ConditionExpression: 'studentId = :me AND #s = :submitted',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':me': studentId, ':submitted': 'submitted' },
      },
    },
    {
      // Missing marker (an application from before the lock rows existed) is fine too.
      Delete: {
        TableName: table(),
        Key: { applicationId: oneKey(studentId, scholarshipId) },
        ConditionExpression: 'attribute_not_exists(applicationId) OR holder = :id',
        ExpressionAttributeValues: { ':id': applicationId },
      },
    },
  ];
  if (mySlot) {
    actions.push({
      Delete: {
        TableName: table(),
        Key: { applicationId: mySlot.applicationId },
        ConditionExpression: 'holder = :id',
        ExpressionAttributeValues: { ':id': applicationId },
      },
    });
  }

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: actions, ClientRequestToken: crypto.randomUUID() }));
    return true;
  } catch (err) {
    if (err.name === 'TransactionCanceledException') return false;
    throw err;
  }
}

module.exports = {
  getApplication, listByStudent, createApplicationAtomic, withdrawAtomic, oneKey, slotKey,
};
