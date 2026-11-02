const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const CATEGORY_NAMES = {
  Normal: '通常',
  Event: 'イベント',
  Triplapse: 'タイムラプス'
};

function parseFilename(fileName, category, camera) {
  const match = /^(FILE|EMER|TRIP)(\d{6})-(\d{6})([FR])\.(mp4|NMEA)$/i.exec(fileName);
  if (!match) return null;

  const [, prefix, date, time, suffix, extension] = match;
  const actualCamera = suffix.toUpperCase();
  if (actualCamera !== camera && extension.toUpperCase() === 'MP4') return null;
  const year = 2000 + Number(date.slice(0, 2));
  const month = Number(date.slice(2, 4));
  const day = Number(date.slice(4, 6));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  const localStart = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (localStart.getUTCFullYear() !== year || localStart.getUTCMonth() !== month - 1 ||
      localStart.getUTCDate() !== day || localStart.getUTCHours() !== hour ||
      localStart.getUTCMinutes() !== minute || localStart.getUTCSeconds() !== second) return null;

  return {
    category,
    prefix: prefix.toUpperCase(),
    timestamp: `${date}-${time}`,
    start: Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 60 * 60 * 1000,
    camera: actualCamera,
    extension: extension.toUpperCase()
  };
}

function nmeaCoordinate(value, hemisphere) {
  const degreesDigits = hemisphere === 'N' || hemisphere === 'S' ? 2 : 3;
  const degrees = Number(value.slice(0, degreesDigits));
  const minutes = Number(value.slice(degreesDigits));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes) || minutes >= 60) return null;
  const coordinate = degrees + minutes / 60;
  const signed = hemisphere === 'S' || hemisphere === 'W' ? -coordinate : coordinate;
  const limit = degreesDigits === 2 ? 90 : 180;
  return Math.abs(signed) <= limit ? signed : null;
}

function parseNmea(content, recordingStart) {
  const points = [];
  let dateAnchor = null;
  for (const line of content.split(/\r?\n/)) {
    const fields = line.trim().split(',');
    if (fields[0]?.endsWith('RMC') && fields[2] === 'A') {
      const dateField = fields[9];
      const clock = fields[1];
      if (!/^\d{6}(?:\.\d+)?$/.test(clock || '') || !/^\d{6}$/.test(dateField || '')) continue;
      const day = Number(dateField.slice(0, 2));
      const month = Number(dateField.slice(2, 4));
      const year = 2000 + Number(dateField.slice(4, 6));
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) continue;
      dateAnchor = { year, month, day };
      const time = clock.split('.');
      const hour = Number(time[0].slice(0, 2));
      const minute = Number(time[0].slice(2, 4));
      const second = Number(time[0].slice(4, 6));
      const fraction = time[1] ? Number(`0.${time[1]}`) : 0;
      const utcTimestamp = Date.UTC(year, month - 1, day, hour, minute, second) +
        Math.round(fraction * 1000);
      const latitude = nmeaCoordinate(fields[3], fields[4]);
      const longitude = nmeaCoordinate(fields[5], fields[6]);
      const speedKnots = Number(fields[7]);
      const course = Number(fields[8]);
      if (latitude === null || longitude === null) continue;
      points.push({
        utcTimestamp,
        timestamp: utcTimestamp,
        latitude,
        longitude,
        speedKmh: Number.isFinite(speedKnots) ? speedKnots * 1.852 : null,
        course: Number.isFinite(course) ? course : null,
        altitude: null
      });
      continue;
    }

    if (fields[0]?.endsWith('GGA') && dateAnchor) {
      const match = points.at(-1);
      if (!match) continue;
      const clock = fields[1]?.split('.')[0];
      if (clock !== matchTime(match.utcTimestamp)) continue;
      const altitude = Number(fields[9]);
      if (Number.isFinite(altitude)) match.altitude = altitude;
    }
  }

  if (points.length && Number.isFinite(recordingStart)) {
    const nearest = points.reduce((best, point) =>
      Math.abs(point.timestamp - recordingStart) < Math.abs(best.timestamp - recordingStart)
        ? point : best);
    if (Math.abs(nearest.timestamp - recordingStart) > 10 * 60 * 1000) {
      const nextDay = nearest.timestamp + 24 * 60 * 60 * 1000;
      const previousDay = nearest.timestamp - 24 * 60 * 60 * 1000;
      const shift = Math.abs(nextDay - recordingStart) < Math.abs(previousDay - recordingStart)
        ? 24 * 60 * 60 * 1000 : -24 * 60 * 60 * 1000;
      for (const point of points) {
        point.utcTimestamp += shift;
        point.timestamp += shift;
      }
    }
  }
  return points;
}

function matchTime(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function buildRecordingGroups(files) {
  const groups = new Map();
  for (const file of files) {
    const parsed = parseFilename(path.basename(file.path), file.category, file.camera);
    if (!parsed) continue;
    const key = `${parsed.category}:${parsed.timestamp}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        category: parsed.category,
        categoryName: CATEGORY_NAMES[parsed.category] ?? parsed.category,
        timestamp: parsed.timestamp,
        start: parsed.start,
        front: null,
        rear: null,
        nmea: null,
        duration: 0,
        gps: []
      });
    }
    const group = groups.get(key);
    if (parsed.extension === 'NMEA') group.nmea = file.path;
    else group[parsed.camera === 'F' ? 'front' : 'rear'] = file.path;
  }
  return [...groups.values()].sort((a, b) => a.start - b.start);
}

function groupGaps(groups) {
  return groups.slice(1).map((group, index) => {
    const previous = groups[index];
    const previousEnd = previous.start + previous.duration * 1000;
    return {
      after: previous.id,
      before: group.id,
      durationMs: Math.max(0, group.start - previousEnd)
    };
  }).filter(gap => gap.durationMs > 1500);
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function copyWithResume(source, destination, onProgress = () => {}) {
  const sourceStat = await fs.stat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  try {
    const destinationStat = await fs.stat(destination);
    if (destinationStat.size === sourceStat.size &&
        await sha256(destination) === await sha256(source)) {
      return { size: sourceStat.size, sha256: await sha256(source), alreadyPresent: true };
    }
    throw new Error(`コピー先に同名の異なるファイルがあります。上書きしません: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let offset = 0;
  try {
    const partialStat = await fs.stat(partial);
    if (partialStat.size <= sourceStat.size) offset = partialStat.size;
    else await fs.truncate(partial, 0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (sourceStat.size === 0 && offset === 0) await fs.writeFile(partial, Buffer.alloc(0));
  if (offset < sourceStat.size) {
    const reader = (await fs.open(source, 'r')).createReadStream({ start: offset });
    const writer = (await fs.open(partial, offset ? 'a' : 'w')).createWriteStream();
    let copied = offset;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        copied += chunk.length;
        onProgress(copied, sourceStat.size);
        callback(null, chunk);
      }
    });
    await pipeline(reader, meter, writer);
  }

  const partialStat = await fs.stat(partial);
  if (partialStat.size !== sourceStat.size) {
    throw new Error(`コピーサイズが一致しません: ${source}`);
  }
  const [sourceHash, destinationHash] = await Promise.all([sha256(source), sha256(partial)]);
  if (sourceHash !== destinationHash) throw new Error(`コピー検証に失敗しました: ${source}`);
  await fs.rename(partial, destination);
  return { size: sourceStat.size, sha256: sourceHash };
}

module.exports = {
  CATEGORY_NAMES,
  buildRecordingGroups,
  copyWithResume,
  groupGaps,
  nmeaCoordinate,
  parseFilename,
  parseNmea
};
