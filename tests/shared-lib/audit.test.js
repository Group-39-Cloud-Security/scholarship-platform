// Tests for shared-lib/audit.js. Run from the repo root:  node --test "tests/shared-lib/*.test.js"
// The AWS SDK isn't installed at the repo root (only inside each service), so the DynamoDB client is replaced
// with a fake before audit.js is loaded. That also means these tests never touch a real table.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const sent = [];
let failNext = false;
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@aws-sdk/lib-dynamodb') return { PutCommand: class { constructor(input) { this.input = input; } } };
  if (request === './dynamo') {
    return {
      docClient: {
        send: async (command) => {
          if (failNext) { failNext = false; throw Object.assign(new Error('AccessDenied for arn:...'), { name: 'AccessDeniedException' }); }
          sent.push(command.input);
        },
      },
    };
  }
  return realLoad.call(this, request, ...rest);
};
const { writeAudit } = require('../../shared-lib/audit');
Module._load = realLoad;

test('writes one item into AUDIT_TABLE with the §5 key shape', async () => {
  process.env.AUDIT_TABLE = 'AuditLog';
  await writeAudit({ action: 'decision', userId: 'test-admin', targetId: 'app-1', detail: 'accepted' });
  const { TableName, Item } = sent.at(-1);
  assert.strictEqual(TableName, 'AuditLog');
  assert.deepStrictEqual(Object.keys(Item).sort(), ['action', 'detail', 'sortKey', 'targetId', 'userId']);
  assert.strictEqual(Item.action, 'decision');
  const [createdAt, logId] = Item.sortKey.split('#');
  assert.strictEqual(new Date(createdAt).toISOString(), createdAt);
  assert.match(logId, /^[0-9a-f-]{36}$/);
});

test('two writes in a row get different sort keys', async () => {
  await writeAudit({ action: 'claim', userId: 'test-reviewer', targetId: 'a' });
  await writeAudit({ action: 'claim', userId: 'test-reviewer', targetId: 'a' });
  assert.notStrictEqual(sent.at(-1).Item.sortKey, sent.at(-2).Item.sortKey);
});

test('a failed write is logged and never thrown', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', (l) => lines.push(JSON.parse(l)));
  failNext = true;
  await assert.doesNotReject(writeAudit({ action: 'forbidden', userId: 'test-student-1', targetId: '/api/admin/stats', detail: 'x' }));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].message, 'audit write failed');
  assert.strictEqual(lines[0].error, 'AccessDeniedException');
  assert.strictEqual(lines[0].detail, undefined); // detail is not copied into the log
});
