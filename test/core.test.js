const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  buildRecordingGroups,
  copyWithResume,
  groupGaps,
  nmeaCoordinate,
  parseFilename,
  parseNmea
} = require('../src/core');

test('parses MiVue file timestamps and rejects invalid calendar dates', () => {
  const parsed = parseFilename('FILE261031-120312F.mp4', 'Normal', 'F');
  assert.equal(parsed.timestamp, '261031-120312');
  assert.equal(new Date(parsed.start).toISOString(), '2026-10-31T03:03:12.000Z');
  assert.equal(parseFilename('FILE261332-120312F.mp4', 'Normal', 'F'), null);
});

test('parses RMC coordinates and converts UTC timestamps to JST', () => {
  const lines = [
    '$GNRMC,030312.000,A,3532.9742,N,13932.1646,E,18.81,202.41,311026,,,D,V*3E',
    '$GNGGA,030312.000,3532.9742,N,13932.1646,E,2,28,0.58,24.5,M,39.4,M,,*48',
    '$GNRMC,030313.000,V,,,,,,,311026,,,N,V*00'
  ].join('\n');
  const points = parseNmea(lines, Date.UTC(2026, 9, 31, 3, 3, 12));
  assert.equal(points.length, 1);
  assert.equal(new Date(points[0].timestamp).toISOString(), '2026-10-31T03:03:12.000Z');
  assert.ok(Math.abs(points[0].latitude - 35.54957) < 0.00001);
  assert.ok(Math.abs(points[0].longitude - 139.536077) < 0.00001);
  assert.ok(Math.abs(points[0].speedKmh - 34.83612) < 0.00001);
  assert.equal(points[0].altitude, 24.5);
});

test('builds camera pairs and reports missing sides and recording gaps', () => {
  const root = path.resolve('Data\\Normal');
  const files = [
    { path: path.join(root, 'F', 'FILE261031-120312F.mp4'), category: 'Normal', camera: 'F' },
    { path: path.join(root, 'R', 'FILE261031-120312R.mp4'), category: 'Normal', camera: 'R' },
    { path: path.join(root, 'NMEA', 'FILE261031-120312F.NMEA'), category: 'Normal', camera: 'NMEA' },
    { path: path.join(root, 'F', 'FILE261031-120415F.mp4'), category: 'Normal', camera: 'F' }
  ];
  const groups = buildRecordingGroups(files);
  assert.equal(groups.length, 2);
  assert.ok(groups[0].front);
  assert.ok(groups[0].rear);
  assert.ok(groups[0].nmea);
  assert.equal(groups[1].rear, null);
  groups[0].duration = 60;
  assert.equal(groupGaps(groups)[0].durationMs, 3000);
});

test('converts NMEA degrees and minutes and rejects malformed coordinates', () => {
  assert.ok(Math.abs(nmeaCoordinate('3532.9742', 'N') - 35.54957) < 0.00001);
  assert.ok(nmeaCoordinate('9132.0000', 'N') === null);
  assert.ok(nmeaCoordinate('13999.0000', 'E') === null);
});

test('copies files with digest verification and resumes a partial file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miomivuer-copy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.mp4');
  const destination = path.join(directory, 'out', 'source.mp4');
  const contents = Buffer.alloc(1024 * 1024 + 37, 0x4d);
  await fs.writeFile(source, contents);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(`${destination}.partial`, contents.subarray(0, 4096));
  let lastProgress = 0;
  const result = await copyWithResume(source, destination, copied => { lastProgress = copied; });
  assert.equal(result.size, contents.length);
  assert.equal(lastProgress, contents.length);
  assert.deepEqual(await fs.readFile(destination), contents);
  await assert.rejects(fs.access(`${destination}.partial`));
  const duplicate = await copyWithResume(source, destination);
  assert.equal(duplicate.alreadyPresent, true);
  await fs.writeFile(destination, 'different file');
  await assert.rejects(copyWithResume(source, destination), /上書きしません/);
});
