const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { buildRecordingGroups, copyWithResume, groupGaps, parseFilename, parseNmea } = require('./core');

let mainWindow;
let selectedRoot;
const playbackCache = path.join(app.getPath('temp'), 'miomivuer-playback');
const recordings = new Map();
const playbackConversions = new Map();
const userSelectedDirectories = new Set();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#0b1118',
    title: 'MiVue Vuer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function resolveInsideRoot(filePath) {
  if (!selectedRoot) throw new Error('先にデータフォルダーを選択してください。');
  const resolved = path.resolve(filePath);
  const relative = path.relative(selectedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('選択したデータフォルダーの外側にはアクセスできません。');
  }
  return resolved;
}

async function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(executable)} が終了コード ${code} で失敗しました: ${stderr.slice(-1800)}`));
    });
  });
}

async function probeDuration(filePath) {
  const output = await runProcess(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration)) throw new Error(`動画の長さを取得できません: ${filePath}`);
  return duration;
}

async function scanRoot(root) {
  selectedRoot = path.resolve(root);
  recordings.clear();
  const files = [];
  const errors = [];
  const rootEntries = await fs.readdir(selectedRoot, { withFileTypes: true }).catch(error => {
    throw new Error(`選択したフォルダーを読み取れません: ${error.message}`);
  });
  const hasRecordingFolder = rootEntries.some(entry =>
    ['Normal', 'Event', 'Triplapse'].includes(entry.name) && entry.isDirectory());
  const hasDeviceInfo = rootEntries.some(entry =>
    entry.name.toLowerCase() === 'device.xml' && entry.isFile());
  if (!hasRecordingFolder && !hasDeviceInfo) {
    throw new Error('選択したフォルダーの直下にEvent、Normal、Triplapseのいずれか、またはDEVICE.XMLが見つかりません。');
  }
  for (const category of ['Normal', 'Event', 'Triplapse']) {
    for (const camera of ['F', 'R', 'NMEA']) {
      const dir = path.join(selectedRoot, category, camera);
      let names;
      try {
        const directoryInfo = await fs.lstat(dir);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
          errors.push(`読み取り対象が通常のフォルダーではありません: ${dir}`);
          continue;
        }
        names = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        errors.push(`${dir}: ${error.message}`);
        continue;
      }
      for (const entry of names) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if ((camera === 'NMEA' && ext !== '.nmea') || (camera !== 'NMEA' && ext !== '.mp4')) continue;
        const file = { path: path.join(dir, entry.name), category, camera };
        if (!parseFilename(entry.name, category, camera)) {
          errors.push(`未対応のファイル名のため読み込みませんでした: ${file.path}`);
        } else {
          files.push(file);
        }
      }
    }
  }

  const groups = buildRecordingGroups(files);
  let nextGroup = 0;
  async function inspectGroups() {
    while (nextGroup < groups.length) {
      const group = groups[nextGroup++];
      const videos = [group.front, group.rear].filter(Boolean);
      try {
        const durations = await Promise.all(videos.map(probeDuration));
        group.duration = durations.length ? Math.max(...durations) : 0;
      } catch (error) {
        errors.push(error.message);
      }
      if (group.nmea) {
        try {
          group.gps = parseNmea(await fs.readFile(group.nmea, 'utf8'), group.start);
        } catch (error) {
          errors.push(`${group.nmea}: ${error.message}`);
        }
      }
      group.frontUrl = group.front ? pathToFileURL(group.front).href : null;
      group.rearUrl = group.rear ? pathToFileURL(group.rear).href : null;
      group.gaps = [];
      recordings.set(group.id, group);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, groups.length) }, inspectGroups));
  for (const gap of groupGaps(groups)) {
    const group = recordings.get(gap.before);
    if (group) group.gapBeforeMs = gap.durationMs;
  }
  return { root: selectedRoot, groups, errors };
}

async function getPlayableFile(filePath) {
  const source = resolveInsideRoot(filePath);
  const stat = await fs.stat(source);
  const key = crypto.createHash('sha256').update(`${source}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  await fs.mkdir(playbackCache, { recursive: true });
  const cached = path.join(playbackCache, `${key}.mp4`);
  let conversion = playbackConversions.get(key);
  if (!conversion) {
    conversion = (async () => {
      try {
        await fs.access(cached);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const temporary = cached.replace(/\.mp4$/i, '.partial.mp4');
        try {
          await runProcess(ffmpegPath, [
            '-y', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-dn', '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temporary
          ]);
          await fs.rename(temporary, cached);
        } catch (conversionError) {
          await fs.rm(temporary, { force: true });
          throw conversionError;
        }
      }
      return pathToFileURL(cached).href;
    })();
    playbackConversions.set(key, conversion);
  }
  try {
    return await conversion;
  } finally {
    if (playbackConversions.get(key) === conversion) {
      playbackConversions.delete(key);
    }
  }
}

function assertRecordingVideo(recordingId, camera) {
  const group = recordings.get(recordingId);
  const file = group?.[camera];
  if (!file) throw new Error('対象の動画が見つかりません。');
  return resolveInsideRoot(file);
}

ipcMain.handle('pick-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Event・Normal・Triplapse・DEVICE.XMLの親フォルダーを選択',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  userSelectedDirectories.add(path.resolve(result.filePaths[0]));
  return scanRoot(result.filePaths[0]);
});

ipcMain.handle('select-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'コピー元の録画フォルダー（Event・Normal等の親）を選択',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  const root = path.resolve(result.filePaths[0]);
  userSelectedDirectories.add(root);
  return root;
});
ipcMain.handle('select-destination', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'コピー先フォルダーを選択',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) return null;
  const root = path.resolve(result.filePaths[0]);
  userSelectedDirectories.add(root);
  return root;
});

ipcMain.handle('copy-data', async (event, sourceRoot, destinationRoot, categories) => {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (!userSelectedDirectories.has(source) || !userSelectedDirectories.has(destination)) {
    throw new Error('コピー元とコピー先は、アプリのフォルダー選択画面から選択してください。');
  }
  const sourceEntries = await fs.readdir(source, { withFileTypes: true }).catch(error => {
    throw new Error(`コピー元を読み取れません: ${error.message}`);
  });
  if (!sourceEntries.some(entry =>
    ['Normal', 'Event', 'Triplapse'].includes(entry.name) && entry.isDirectory()) &&
      !sourceEntries.some(entry => entry.name.toLowerCase() === 'device.xml' && entry.isFile())) {
    throw new Error('コピー元の直下にEvent、Normal、Triplapse、DEVICE.XMLが見つかりません。');
  }
  const destinationRelative = path.relative(source, destination);
  const destinationIsInsideSource = destinationRelative === '' ||
    (!path.isAbsolute(destinationRelative) && destinationRelative !== '..' &&
      !destinationRelative.startsWith(`..${path.sep}`));
  if (destinationIsInsideSource) {
    throw new Error('コピー先はコピー元フォルダーの外側を指定してください。');
  }
  const report = [];
  const deviceInfo = path.join(source, 'DEVICE.XML');
  let hasDeviceInfo = true;
  try {
    await fs.access(deviceInfo);
  } catch (error) {
    if (error.code === 'ENOENT') hasDeviceInfo = false;
    else throw error;
  }
  if (hasDeviceInfo) {
    try {
      const deviceInfoEntry = await fs.lstat(deviceInfo);
      if (!deviceInfoEntry.isFile() || deviceInfoEntry.isSymbolicLink()) {
        throw new Error('デバイス情報が通常のファイルではありません。');
      }
      const result = await copyWithResume(deviceInfo, path.join(destination, 'DEVICE.XML'), (copied, total) => {
        event.sender.send('copy-progress', { source: deviceInfo, copied, total });
      });
      report.push({ source: deviceInfo, destination: path.join(destination, 'DEVICE.XML'), status: 'verified', ...result });
      event.sender.send('copy-file-complete', report.at(-1));
    } catch (error) {
      report.push({ source: deviceInfo, destination: path.join(destination, 'DEVICE.XML'), status: 'error', error: error.message });
      event.sender.send('copy-file-error', report.at(-1));
    }
  }
  for (const category of categories) {
    if (!['Normal', 'Event', 'Triplapse'].includes(category)) throw new Error('不明な録画カテゴリーです。');
    const directory = path.join(source, category);
    try {
      const directoryInfo = await fs.lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        report.push({ source: directory, status: 'error', error: 'コピー対象が通常のフォルダーではありません。' });
        event.sender.send('copy-file-error', report.at(-1));
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const filePaths = [];
    async function walk(current) {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) filePaths.push(absolute);
      }
    }
    await walk(directory);
    for (const from of filePaths) {
      const relative = path.relative(source, from);
      const to = path.join(destination, relative);
      try {
        const result = await copyWithResume(from, to, (copied, total) => {
          event.sender.send('copy-progress', { source: from, copied, total });
        });
        report.push({ source: from, destination: to, status: 'verified', ...result });
        event.sender.send('copy-file-complete', report.at(-1));
      } catch (error) {
        report.push({ source: from, destination: to, status: 'error', error: error.message });
        event.sender.send('copy-file-error', report.at(-1));
      }
    }
  }
  return report;
});

ipcMain.handle('trim-pair', async (_event, recordingId, startSeconds, endSeconds, cameras, mode) => {
  const outputs = [];
  if (!['copy', 'precise'].includes(mode)) throw new Error('トリミング方式が正しくありません。');
  for (const camera of cameras) {
    const input = assertRecordingVideo(recordingId, camera);
    const duration = await probeDuration(input);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 ||
        endSeconds <= startSeconds || endSeconds > duration) {
      throw new Error(`${camera === 'front' ? '前方' : '後方'}動画の切り出し範囲が正しくありません。`);
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `${camera === 'front' ? '前方' : '後方'}動画の保存先`,
      defaultPath: `${path.parse(input).name}_trimmed.mp4`,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    });
    if (result.canceled || !result.filePath) return outputs;
    const trimArgs = mode === 'copy'
      ? ['-y', '-ss', String(startSeconds), '-i', input, '-t', String(endSeconds - startSeconds),
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart', result.filePath]
      : ['-y', '-ss', String(startSeconds), '-i', input, '-t', String(endSeconds - startSeconds),
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-crf', '18',
        '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', result.filePath];
    await runProcess(ffmpegPath, trimArgs);
    outputs.push(result.filePath);
  }
  return outputs;
});

ipcMain.handle('open-external', async (_event, url) => {
  if (!/^https:\/\/(www\.)?openstreetmap\.org\//.test(url)) throw new Error('許可されていないURLです。');
  await shell.openExternal(url);
});
ipcMain.handle('get-playable-file', async (_event, filePath) => getPlayableFile(filePath));
