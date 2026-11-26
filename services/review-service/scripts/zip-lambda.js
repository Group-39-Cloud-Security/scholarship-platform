// Builds the two zips Lambda runs.  Usage:  npm run zip  (run npm run sync-shared first)
//   lambda.zip                 = review-service: src/, shared/, package.json, node_modules/
//   release-expired-claims.zip = the hourly job: handler.js, shared/, its own package.json and node_modules/
//     (the job only needs the DynamoDB client, so it does not ship Express or the S3 client)
// Copied from Lab 7 (scripts/zip-lambda.js), no extra package. Contains ONLY the fixed lists below,
// so .env, events/ and tests/ can never end up in a zip.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');

if (!fs.existsSync(path.join(root, 'node_modules', 'serverless-http'))
  || !fs.existsSync(path.join(root, 'release-expired-claims', 'node_modules', '@aws-sdk'))) {
  console.error('Run "npm install" in this service folder first, then "npm run zip" (it installs release-expired-claims too).');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'shared', 'VERSION')) || !fs.existsSync(path.join(root, 'release-expired-claims', 'shared', 'VERSION'))) {
  console.error('Run "npm run sync-shared" first (shared/ is missing).');
  process.exit(1);
}

// List every file to include: [absolute path on disk, name inside the zip]
function collect(p, nameInZip, files) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(p).sort()) {
      if (name === '.bin' || name === '.package-lock.json') continue;
      collect(path.join(p, name), `${nameInZip}/${name}`, files);
    }
  } else if (stat.isFile()) {
    files.push([p, nameInZip]);
  }
}

// Write a standard .zip file (no extra tools needed)
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function writeZip(outputName, entries) {
  const files = [];
  entries.forEach(([from, to]) => fs.existsSync(path.join(root, from)) && collect(path.join(root, from), to, files));
  const output = path.join(root, outputName);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [file, nameInZip] of files) {
    const name = Buffer.from(nameInZip);
    const data = fs.readFileSync(file);
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0x5021, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x5021, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);

  fs.writeFileSync(output, Buffer.concat([...parts, ...central, end]));
  const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
  console.log(`Created review-service/${outputName} (${files.length} files, ${mb} MB). .env is NOT included.`);
}

writeZip('lambda.zip', [['src', 'src'], ['shared', 'shared'], ['package.json', 'package.json'], ['node_modules', 'node_modules']]);
writeZip('release-expired-claims.zip', [
  ['release-expired-claims/handler.js', 'handler.js'],
  ['release-expired-claims/shared', 'shared'],
  ['release-expired-claims/package.json', 'package.json'],
  ['release-expired-claims/node_modules', 'node_modules'],
]);
