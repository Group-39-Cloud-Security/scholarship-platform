// fill-test-plan.js — copies Actual and Pass/Fail for every T-APP row from an evidence file into docs/api-test-plan.md.
// Owner: Mohamed Khalil.  Usage (from the repo root):
//   node services/application-service/scripts/fill-test-plan.js evidence/application-api-tests-floci.txt
// Only T-APP rows change. A T-APP row with no result in the evidence file is marked "not run".

const fs = require('fs');
const path = require('path');

const evidencePath = process.argv[2];
if (!evidencePath) { console.error('usage: node fill-test-plan.js <evidence file>'); process.exit(1); }
const evidence = fs.readFileSync(evidencePath, 'utf8').replace(/\r/g, '');
const planPath = path.join(__dirname, '..', '..', '..', 'docs', 'api-test-plan.md');
const plan = fs.readFileSync(planPath, 'utf8');
const evidenceName = path.relative(path.dirname(path.dirname(planPath)), path.resolve(evidencePath)).split(path.sep).join('/');

// "PASS  T-APP-01   browse without a token → 401  (actual: 401 UNAUTHENTICATED "...")"
const results = new Map();
for (const line of evidence.split('\n')) {
  const m = line.match(/^(PASS|FAIL)\s+(T-APP-\d+)\s+.*\(actual: (.*)\)\s*$/);
  if (m) results.set(m[2], { verdict: m[1], actual: m[3] });
}
if (results.size === 0) { console.error('No PASS/FAIL lines for T-APP tests found in that file.'); process.exit(1); }

const cell = (text) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim(); // a "|" would break the table
let filled = 0;
let notRun = 0;
const out = plan.split('\n').map((line) => {
  if (!line.startsWith('| T-APP-')) return line;
  const cols = line.split(/(?<!\\)\|/); // ['', ' T-APP-01 ', service, request, expected, actual, pass, evidence, '']
  if (cols.length < 9) return line;
  const id = cols[1].trim();
  const r = results.get(id);
  if (r) {
    cols[5] = ` ${cell(r.actual)} `;
    cols[6] = ` ${r.verdict} `;
    cols[7] = ` ${evidenceName} `;
    filled += 1;
  } else {
    cols[5] = ' not run ';
    cols[6] = ' not run ';
    notRun += 1;
  }
  return cols.join('|');
});
fs.writeFileSync(planPath, out.join('\n'));
const failed = [...results.values()].filter((r) => r.verdict === 'FAIL').length;
console.log(`docs/api-test-plan.md: ${filled} T-APP rows filled (${filled - failed} PASS, ${failed} FAIL), ${notRun} not run`);
