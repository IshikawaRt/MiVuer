const CATEGORY_LABELS = { Normal: '通常', Event: 'イベント', Triplapse: 'タイムラプス' };
const ui = Object.fromEntries([
  'source-name', 'open-source', 'record-count', 'filter-from', 'filter-to', 'filter-front',
  'filter-rear', 'filter-gps', 'apply-filter', 'record-list', 'gap-summary', 'playing-title',
  'playback-state', 'video-front', 'video-rear', 'front-empty', 'rear-empty', 'previous',
  'play-toggle', 'next', 'mute-toggle', 'clock-label', 'gap-label', 'seek', 'elapsed',
  'duration', 'timeline', 'gps-status', 'speed', 'latitude', 'longitude', 'altitude',
  'course', 'speed-chart', 'map', 'open-map', 'trim-start', 'trim-end', 'trim-camera', 'trim-mode',
  'trim-save', 'notice', 'copy-open', 'copy-dialog', 'copy-source', 'copy-destination',
  'choose-copy-source', 'choose-copy-destination', 'copy-start', 'copy-close',
  'copy-progress', 'copy-percent', 'copy-status', 'copy-errors',
  'g-chart', 'g-x', 'g-y', 'g-z', 'g-status',
  'app-layout', 'library-panel', 'search-panel', 'search-toggle', 'trim-panel', 'trim-toggle'
].map(id => [id, document.getElementById(id)]));

const state = {
  root: null,
  groups: [],
  visibleGroups: [],
  selected: null,
  currentIndex: -1,
  playing: false,
  syncing: false,
  map: null,
  route: null,
  routeId: null,
  marker: null,
  currentPosition: null,
  copyErrors: [],
  loadController: null,
  prepared: null,
  advancing: false,
  crossfade: null,
  audioTimer: null
};

function showNotice(message, type = '') {
  ui.notice.textContent = message;
  ui.notice.className = `notice ${type}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function localDate(timestamp, options = {}) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    ...options
  }).format(new Date(timestamp));
}

function dateInputAsJst(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(match[6] ?? 0);
  return Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 60 * 60 * 1000;
}

function selectedCategories() {
  return [...document.querySelectorAll('.category-filter:checked')].map(input => input.value);
}

function filteredGroups() {
  const from = ui['filter-from'].value ? dateInputAsJst(ui['filter-from'].value) : -Infinity;
  const to = ui['filter-to'].value ? dateInputAsJst(ui['filter-to'].value) : Infinity;
  const categories = selectedCategories();
  return state.groups.filter(group => {
    if (!categories.includes(group.category) || group.start < from || group.start > to) return false;
    if (ui['filter-front'].checked && !group.front) return false;
    if (ui['filter-rear'].checked && !group.rear) return false;
    if (ui['filter-gps'].checked && !group.nmea) return false;
    return true;
  });
}

function renderRecordList() {
  state.visibleGroups = filteredGroups();
  ui['record-count'].textContent = String(state.visibleGroups.length);
  if (!state.visibleGroups.length) {
    ui['record-list'].innerHTML = '<div class="empty-state">条件に一致する録画はありません</div>';
    renderTimeline();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const group of state.visibleGroups) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `record-row${group.id === state.selected?.id ? ' selected' : ''}`;
    row.setAttribute('aria-label', `${localDate(group.start, { dateStyle: 'short', timeStyle: 'medium' })} ${group.categoryName}`);
    const left = document.createElement('span');
    left.className = 'record-info';
    const date = document.createElement('strong');
    date.textContent = localDate(group.start, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const detail = document.createElement('small');
    detail.textContent = `${CATEGORY_LABELS[group.category] ?? group.category} · ${formatDuration(group.duration)}`;
    left.append(date, detail);
    const badges = document.createElement('span');
    badges.className = 'record-badges';
    for (const [label, exists] of [['F', group.front], ['R', group.rear], ['GPS', group.nmea]]) {
      const badge = document.createElement('span');
      badge.className = `badge ${exists ? 'present' : 'missing'}`;
      badge.textContent = label;
      badges.append(badge);
    }
    row.append(left, badges);
    row.addEventListener('click', () => selectRecording(group));
    fragment.append(row);
  }
  ui['record-list'].replaceChildren(fragment);
  renderTimeline();
}

function renderTimeline() {
  const groups = state.visibleGroups;
  ui.timeline.replaceChildren();
  if (!groups.length) {
    ui['gap-summary'].textContent = '該当する録画がありません';
    return;
  }
  let total = 0;
  const entries = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const previous = groups[index - 1];
    const gap = previous ? Math.max(0, group.start - (previous.start + previous.duration * 1000)) : 0;
    const durationMs = Math.max(1, group.duration * 1000);
    entries.push({ group, gap, durationMs });
    total += gap + durationMs;
  }
  let gapCount = 0;
  for (const entry of entries) {
    if (entry.gap > 1500) {
      const gapPart = document.createElement('span');
      gapPart.className = 'timeline-gap';
      gapPart.style.flex = `${entry.gap} 0 0`;
      gapPart.title = `録画なし: ${formatDuration(entry.gap / 1000)}`;
      ui.timeline.append(gapPart);
      gapCount += 1;
    }
    const part = document.createElement('span');
    part.className = `timeline-part${entry.group.id === state.selected?.id ? ' active' : ''}`;
    part.style.flex = `${entry.durationMs} 0 0`;
    part.title = `${localDate(entry.group.start, { dateStyle: 'short', timeStyle: 'medium' })} · ${entry.group.categoryName}`;
    ui.timeline.append(part);
  }
  ui['gap-summary'].textContent = gapCount ? `${gapCount}か所の録画空白` : '録画空白なし';
}

async function openSource() {
  ui['open-source'].disabled = true;
  ui['open-source'].textContent = '読み込み中…';
  try {
    const scan = await window.miovuer.pickRoot();
    if (!scan) return;
    adoptScan(scan);
    if (state.visibleGroups.length) await selectRecording(state.visibleGroups[0]);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    ui['open-source'].disabled = false;
    ui['open-source'].textContent = '録画フォルダーを開く';
  }
}

function adoptScan(scan) {
  state.loadController?.abort();
  discardPrepared();
  pause();
  state.selected = null;
  state.currentIndex = -1;
  state.root = scan.root;
  state.groups = scan.groups;
  ui['source-name'].textContent = scan.root;
  renderRecordList();
  const missingFront = scan.groups.filter(group => !group.front).length;
  const missingRear = scan.groups.filter(group => !group.rear).length;
  const status = `${scan.groups.length}件を読み込みました。前方なし ${missingFront}件、後方なし ${missingRear}件。`;
  showNotice(scan.errors.length ? `${status} 読み込み警告 ${scan.errors.length}件: ${scan.errors[0]}` : status, scan.errors.length ? 'error' : 'success');
  if (!scan.groups.length) ui['record-list'].innerHTML = '<div class="empty-state">選択したフォルダー直下に録画が見つかりません。Event・Normal・Triplapseの親を選択してください。</div>';
}

async function loadVideo(video, filePath, emptyElement, signal) {
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (!filePath) {
    emptyElement.hidden = false;
    return;
  }
  emptyElement.hidden = false;
  emptyElement.textContent = '動画を準備しています…';
  const url = await window.miovuer.getPlayableFile(filePath);
  signal.throwIfAborted();
  const camera = video.id === 'video-front' || video.dataset.camera === 'front' ? '前方' : '後方';
  const filename = filePath.split(/[\\/]/).at(-1);
  await new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => {
      const mediaError = video.error;
      const reasons = {
        1: '読み込みが中断されました',
        2: '動画ファイルを読み取れません',
        3: '映像または音声をデコードできません',
        4: '動画の形式またはコーデックが未対応です'
      };
      cleanup();
      reject(new Error(`${camera}: ${filename} — ${reasons[mediaError?.code] ?? '動画の読み込みに失敗しました'}${mediaError ? ` (code=${mediaError.code}: ${mediaError.message})` : ''}`));
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${camera}: ${filename} — 動画の読み込みがタイムアウトしました。ドライブの接続状態を確認してください。`));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', done);
      video.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    video.preload = 'auto';
    video.src = url;
    video.load();
  });
  signal.throwIfAborted();
  emptyElement.hidden = true;
}

function discardPrepared() {
  cancelCrossfade();
  const prepared = state.prepared;
  state.prepared = null;
  if (!prepared) return;
  prepared.controller.abort();
  for (const video of prepared.videos) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

function cancelCrossfade() {
  clearInterval(state.audioTimer);
  state.audioTimer = null;
  const fade = state.crossfade;
  state.crossfade = null;
  if (fade) {
    for (const video of fade.prepared.videos) {
      video.pause();
      if (video.readyState >= 1) video.currentTime = 0;
      video.volume = 1;
      video.muted = true;
    }
    fade.prepared.started = false;
  }
  ui['video-front'].volume = 1;
}

function monitorAudioTransition() {
  clearInterval(state.audioTimer);
  state.audioTimer = setInterval(() => {
    const prepared = state.prepared;
    const primary = state.selected?.front ? ui['video-front'] : ui['video-rear'];
    if (!state.playing || !prepared?.ready || state.advancing || primary.seeking) return;
    const remaining = primary.duration - primary.currentTime;
    if (!state.crossfade && remaining > 0 && remaining <= 0.1 && !prepared.fadeFailed) {
      const fade = { prepared, running: false };
      state.crossfade = fade;
      const muted = ui['mute-toggle'].textContent === '🔇';
      for (const [index, video] of prepared.videos.entries()) {
        video.volume = 0;
        video.muted = index === 1 || muted;
      }
      Promise.all(prepared.videos.filter((video, index) =>
        prepared.group[index === 0 ? 'front' : 'rear']).map(video => video.play())
      ).then(() => {
        if (state.crossfade !== fade || state.prepared !== prepared) return;
        prepared.started = true;
        fade.running = true;
      }).catch(error => {
        if (state.crossfade !== fade) return;
        cancelCrossfade();
        prepared.fadeFailed = true;
        showNotice(`音声の先行再生に失敗しました。通常の自動切り替えを使用します: ${error.message}`, 'error');
        if (state.playing) monitorAudioTransition();
      });
    }
    const fade = state.crossfade;
    if (fade?.running) {
      const progress = Math.min(1, Math.max(0, 1 - remaining / 0.1));
      ui['video-front'].volume = 1 - progress;
      fade.prepared.videos[0].volume = progress;
    }
  }, 10);
}

function prepareNextRecording() {
  const index = state.visibleGroups.findIndex(group => group.id === state.selected?.id);
  const next = index >= 0 ? state.visibleGroups[index + 1] : null;
  if (state.prepared?.group.id === next?.id) return;
  discardPrepared();
  if (!next) return;
  const controller = new AbortController();
  const videos = ['front', 'rear'].map(camera => {
    const video = ui[`video-${camera}`].ownerDocument.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    video.muted = true;
    video.hidden = true;
    video.dataset.camera = camera;
    ui[`video-${camera}`].parentElement.append(video);
    return video;
  });
  const prepared = { group: next, videos, controller, ready: false };
  state.prepared = prepared;
  prepared.promise = Promise.all(videos.map((video, index) =>
    loadVideo(video, next[index === 0 ? 'front' : 'rear'],
      document.createElement('div'), controller.signal)
  )).then(() => {
    prepared.ready = true;
    return true;
  }).catch(error => {
    if (!controller.signal.aborted) {
      prepared.error = error;
      showNotice(`次の録画の先読みに失敗しました: ${error.message}`, 'error');
    }
    return false;
  });
}

function activatePrepared(prepared) {
  clearInterval(state.audioTimer);
  state.audioTimer = null;
  state.crossfade = null;
  const muted = ui['video-front'].muted;
  for (const [index, camera] of ['front', 'rear'].entries()) {
    const old = ui[`video-${camera}`];
    old.pause();
    old.removeAttribute('src');
    old.load();
    old.remove();
    const video = prepared.videos[index];
    video.id = `video-${camera}`;
    video.hidden = false;
    video.muted = camera === 'rear' || muted;
    video.volume = 1;
    ui[`video-${camera}`] = video;
    ui[`${camera}-empty`].hidden = !!prepared.group[camera];
    ui[`${camera}-empty`].textContent = `${camera === 'front' ? '前方' : '後方'}カメラなし`;
    bindVideoEvents(video);
  }
  state.prepared = null;
}

async function selectRecording(group, autoplay = true, prepared = null) {
  if (prepared) activatePrepared(prepared);
  else discardPrepared();
  state.loadController?.abort();
  const controller = new AbortController();
  state.loadController = controller;
  const { signal } = controller;
  const index = state.visibleGroups.findIndex(item => item.id === group.id);
  if (index >= 0) state.currentIndex = index;
  state.selected = group;
  state.currentPosition = null;
  state.playing = false;
  ui['play-toggle'].textContent = '▶';
  ui['playback-state'].textContent = '読み込み中';
  ui['playing-title'].textContent = `${localDate(group.start, { dateStyle: 'medium', timeStyle: 'short' })} · ${group.categoryName}`;
  ui['trim-start'].value = '0';
  ui['trim-end'].value = group.duration ? group.duration.toFixed(1) : '';
  ui['trim-save'].disabled = !group.front && !group.rear;
  ui['front-empty'].textContent = group.front ? '前方動画を読み込み中…' : '前方カメラなし';
  ui['rear-empty'].textContent = group.rear ? '後方動画を読み込み中…' : '後方カメラなし';
  renderRecordList();
  try {
    if (!prepared) {
      await Promise.all([
        loadVideo(ui['video-front'], group.front, ui['front-empty'], signal),
        loadVideo(ui['video-rear'], group.rear, ui['rear-empty'], signal)
      ]);
    }
    signal.throwIfAborted();
    ui['video-front'].muted = ui['mute-toggle'].textContent === '🔇';
    ui['video-rear'].muted = true;
    if (!prepared?.started) {
      ui['video-front'].currentTime = 0;
      ui['video-rear'].currentTime = 0;
    }
    ui['playback-state'].textContent = '準備完了';
    ui['gap-label'].textContent = group.gapBeforeMs > 1500 ? `前の録画から ${formatDuration(group.gapBeforeMs / 1000)} の空白` : '';
    updatePlaybackInfo();
    updateTelemetry();
    updateMap();
    prepareNextRecording();
    if (autoplay) await play();
    signal.throwIfAborted();
    showNotice('前後動画を読み込みました。録画ファイルは読み取り専用で扱っています。', 'success');
  } catch (error) {
    if (signal.aborted) return;
    controller.abort();
    pause();
    ui['playback-state'].textContent = '読み込みエラー';
    showNotice(error.message, 'error');
  }
}

async function play() {
  if (!state.selected) return;
  try {
    state.playing = true;
    ui['playback-state'].textContent = '再生中';
    ui['play-toggle'].textContent = 'Ⅱ';
    const promises = [];
    if (state.selected.front) promises.push(ui['video-front'].play());
    if (state.selected.rear) promises.push(ui['video-rear'].play());
    await Promise.all(promises);
    monitorAudioTransition();
  } catch (error) {
    state.playing = false;
    cancelCrossfade();
    ui['video-front'].pause();
    ui['video-rear'].pause();
    ui['playback-state'].textContent = '再生できません';
    ui['play-toggle'].textContent = '▶';
    showNotice(`再生を開始できませんでした: ${error.message}`, 'error');
  }
}

function pause() {
  state.playing = false;
  cancelCrossfade();
  ui['video-front'].pause();
  ui['video-rear'].pause();
  ui['play-toggle'].textContent = '▶';
  ui['playback-state'].textContent = '一時停止';
}

function seekTo(seconds) {
  cancelCrossfade();
  state.syncing = true;
  for (const video of [ui['video-front'], ui['video-rear']]) {
    if (video.src && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(Math.max(0, seconds), video.duration);
    }
  }
  state.syncing = false;
  updatePlaybackInfo();
  updateTelemetry();
  if (state.playing) monitorAudioTransition();
}

function updatePlaybackInfo() {
  const video = state.selected?.front ? ui['video-front'] : ui['video-rear'];
  if (!video || !Number.isFinite(video.duration)) return;
  const duration = video.duration;
  const elapsed = video.currentTime || 0;
  ui.seek.value = String(Math.round(elapsed / duration * 1000));
  ui.elapsed.textContent = formatDuration(elapsed);
  ui.duration.textContent = formatDuration(duration);
  ui['clock-label'].textContent = localDate(state.selected.start + elapsed * 1000, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  drawChart();
}

function updateTelemetry() {
  drawGChart();
  if (!state.selected?.gps?.length) {
    ui['gps-status'].textContent = state.selected?.nmea ? '有効なGPSデータなし' : 'NMEAなし';
    for (const id of ['speed', 'latitude', 'longitude', 'altitude', 'course']) ui[id].textContent = '--';
    state.currentPosition = null;
    drawChart();
    updateMap();
    return;
  }
  const video = state.selected.front ? ui['video-front'] : ui['video-rear'];
  const target = state.selected.start + (video.currentTime || 0) * 1000;
  let low = 0;
  let high = state.selected.gps.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (state.selected.gps[mid].timestamp < target) low = mid + 1;
    else high = mid;
  }
  const after = state.selected.gps[low];
  const before = state.selected.gps[Math.max(0, low - 1)];
  const point = Math.abs(before.timestamp - target) <= Math.abs(after.timestamp - target) ? before : after;
  if (Math.abs(point.timestamp - target) > 5000) {
    ui['gps-status'].textContent = 'この時間のGPSデータなし';
    state.currentPosition = null;
    updateMap();
    return;
  }
  state.currentPosition = point;
  ui['gps-status'].textContent = `${state.selected.gps.length}点 · UTC→JST`;
  ui.speed.textContent = point.speedKmh === null ? '--' : point.speedKmh.toFixed(0);
  ui.latitude.textContent = point.latitude.toFixed(5);
  ui.longitude.textContent = point.longitude.toFixed(5);
  ui.altitude.textContent = point.altitude === null ? '--' : point.altitude.toFixed(1);
  ui.course.textContent = point.course === null ? '--' : point.course.toFixed(0);
  updateMap();
  drawChart();
}

function drawGChart() {
  const canvas = ui['g-chart'];
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = canvas.ownerDocument.defaultView.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  const points = state.selected?.acceleration ?? [];
  const video = state.selected?.front ? ui['video-front'] : ui['video-rear'];
  const elapsed = video.currentTime || 0;
  const duration = state.selected?.duration || 1;
  const current = points.reduce((best, point) =>
    !best || Math.abs(point.offset - elapsed) < Math.abs(best.offset - elapsed) ? point : best, null);
  const valid = current && Math.abs(current.offset - elapsed) <= 1.5;
  ui['g-status'].textContent = points.length
    ? valid ? `${points.length}点` : 'この時刻のG値なし' : 'Gデータなし';
  for (const axis of ['x', 'y', 'z']) ui[`g-${axis}`].textContent = valid ? current[axis].toFixed(3) : '--';
  let limit = 0.4;
  for (const point of points) limit = Math.max(limit, Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
  limit = Math.ceil(limit * 10) / 10;
  const left = 40;
  const width = Math.max(1, bounds.width - left - 5);
  const height = bounds.height - 16;
  const yPosition = value => 8 + (limit - value) / (2 * limit) * height;
  context.font = '9px monospace';
  for (const value of [-limit, 0, limit]) {
    const y = yPosition(value);
    context.fillStyle = '#8293a3';
    context.fillText(`${value.toFixed(1)}G`, 0, y + 3);
    context.strokeStyle = '#283944';
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(left + width, y);
    context.stroke();
  }
  for (const [axis, color] of [['x', '#51d8ca'], ['y', '#ffce63'], ['z', '#a795ff']]) {
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 1.4;
    points.forEach((point, index) => {
      const x = left + point.offset / duration * width;
      const y = yPosition(point[axis]);
      if (!index || point.offset - points[index - 1].offset > 1.5) context.moveTo(x, y);
      else context.lineTo(x, y);
      context.fillStyle = color;
      context.fillRect(x - 1, y - 1, 2, 2);
    });
    context.stroke();
  }
  context.strokeStyle = '#ff843c';
  context.beginPath();
  const cursor = left + Math.min(elapsed / duration, 1) * width;
  context.moveTo(cursor, 0);
  context.lineTo(cursor, bounds.height);
  context.stroke();
}

function drawChart() {
  const canvas = ui['speed-chart'];
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = canvas.ownerDocument.defaultView.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  const width = bounds.width;
  const height = bounds.height;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#283944';
  context.lineWidth = 1;
  for (let index = 0; index < 3; index += 1) {
    const y = 8 + index * (height - 16) / 2;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  const points = state.selected?.gps?.filter(point => Number.isFinite(point.speedKmh)) ?? [];
  if (points.length < 2) return;
  const maxSpeed = Math.max(30, Math.ceil(Math.max(...points.map(point => point.speedKmh)) / 20) * 20);
  context.beginPath();
  context.strokeStyle = '#51d8ca';
  context.lineWidth = 1.8;
  points.forEach((point, index) => {
    const x = (point.timestamp - points[0].timestamp) / Math.max(1, points.at(-1).timestamp - points[0].timestamp) * width;
    const y = height - 7 - point.speedKmh / maxSpeed * (height - 15);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
  if (state.currentPosition) {
      const x = (state.currentPosition.timestamp - points[0].timestamp) / Math.max(1, points.at(-1).timestamp - points[0].timestamp) * width;
    context.beginPath();
    context.strokeStyle = '#ff843c';
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
}

function updateMap() {
  const leaflet = ui.map.ownerDocument.defaultView.L;
  if (!leaflet) {
    ui['open-map'].disabled = true;
    if (ui.map.dataset.mapReady !== 'true') {
      ui.map.innerHTML = '<div class="map-placeholder">地図ライブラリを読み込めません。インターネット接続を確認してください。</div>';
    }
    return;
  }
  if (!state.selected?.gps?.length) {
    state.map?.remove();
    state.map = null;
    state.route = null;
    state.routeId = null;
    state.marker = null;
    ui['open-map'].disabled = true;
    ui.map.dataset.mapReady = 'false';
    ui.map.innerHTML = '<div class="map-placeholder">有効なGPS情報がありません</div>';
    return;
  }
  if (!state.map) {
    ui.map.innerHTML = '';
    ui.map.dataset.mapReady = 'true';
    const firstPoint = state.selected.gps[0];
    state.map = leaflet.map(ui.map, { zoomControl: true, attributionControl: true })
      .setView([firstPoint.latitude, firstPoint.longitude], 14, { animate: false });
    leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);
  }
  if (state.routeId !== state.selected.id) {
    const route = state.selected.gps.map(point => [point.latitude, point.longitude]);
    if (state.route) state.route.remove();
    state.route = leaflet.polyline(route, { color: '#1677ff', weight: 3, opacity: 0.8 }).addTo(state.map);
    state.routeId = state.selected.id;
  }
  if (!state.currentPosition) {
    if (state.marker) {
      state.marker.remove();
      state.marker = null;
    }
    ui['open-map'].disabled = true;
    return;
  }
  const location = [state.currentPosition.latitude, state.currentPosition.longitude];
  if (!state.marker) {
    const icon = leaflet.divIcon({
      className: 'vehicle-marker',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      html: '<svg class="vehicle-heading" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 L28 28 L16 22 L4 28 Z" fill="#1677ff" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg><span class="vehicle-position-dot" hidden></span>'
    });
    state.marker = leaflet.marker(location, { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(state.map);
  }
  else state.marker.setLatLng(location);
  const markerElement = state.marker.getElement();
  const course = state.currentPosition.course;
  const hasHeading = Number.isFinite(course) && course >= 0 && course <= 360;
  const heading = markerElement.querySelector('.vehicle-heading');
  heading.style.display = hasHeading ? '' : 'none';
  heading.style.transform = hasHeading ? `rotate(${course}deg)` : '';
  markerElement.querySelector('.vehicle-position-dot').hidden = hasHeading;
  markerElement.setAttribute('role', 'img');
  markerElement.setAttribute('aria-label', hasHeading
    ? `自車位置・進行方位 ${course.toFixed(0)}度（北が0度）` : '自車位置・進行方位不明');
  const zoom = state.map.getZoom();
  state.map.setView(location, Number.isFinite(zoom) ? Math.max(zoom, 14) : 14, { animate: false });
  ui['open-map'].disabled = false;
}

function moveSelection(direction) {
  if (!state.visibleGroups.length) return;
  const current = Math.max(0, state.currentIndex);
  const target = Math.min(state.visibleGroups.length - 1, Math.max(0, current + direction));
  selectRecording(state.visibleGroups[target], state.playing);
}

async function advanceAfterEnd() {
  if (state.advancing) return;
  const autoplay = state.playing;
  const index = state.visibleGroups.findIndex(group => group.id === state.selected?.id) + 1;
  if (index >= state.visibleGroups.length) {
    pause();
    ui['playback-state'].textContent = '再生完了';
    showNotice('検索結果の最後まで再生しました。', 'success');
    return;
  }
  const next = state.visibleGroups[index];
  const gap = Math.max(0, next.start - (state.selected.start + state.selected.duration * 1000));
  ui['gap-label'].textContent = gap > 1500 ? `録画空白 ${formatDuration(gap / 1000)} を越えて次へ` : '次の録画へ';
  state.advancing = true;
  try {
    let prepared = state.prepared;
    if (prepared?.group.id !== next.id) {
      prepareNextRecording();
      prepared = state.prepared;
    }
    if (prepared) {
      const currentId = state.selected?.id;
      if (!prepared.ready) {
        ui['playback-state'].textContent = '次の録画を準備中';
        await prepared.promise;
      }
      if (state.prepared !== prepared || state.selected?.id !== currentId) return;
      if (autoplay && !state.playing) return;
      if (!prepared.ready) throw prepared.error ?? new Error('次の録画を準備できませんでした。');
      await selectRecording(next, autoplay, prepared);
    } else {
      await selectRecording(next, autoplay);
    }
  } catch (error) {
    pause();
    ui['playback-state'].textContent = '読み込みエラー';
    showNotice(error.message, 'error');
  } finally {
    state.advancing = false;
  }
}

function handleTimeUpdate(event) {
  const primary = state.selected?.front ? ui['video-front'] : ui['video-rear'];
  const video = event.currentTarget;
  if (video === primary) {
    if (!state.syncing) {
      const secondary = video === ui['video-front'] ? ui['video-rear'] : ui['video-front'];
      if (secondary.src && Number.isFinite(secondary.duration) && Math.abs(secondary.currentTime - video.currentTime) > 0.35) {
        secondary.currentTime = Math.min(video.currentTime, secondary.duration);
      }
    }
    updatePlaybackInfo();
    updateTelemetry();
  }
}

async function saveTrim() {
  const group = state.selected;
  if (!group) return;
  const start = Number(ui['trim-start'].value);
  const end = Number(ui['trim-end'].value);
  const choice = ui['trim-camera'].value;
  const cameras = choice === 'both' ? ['front', 'rear'] : [choice];
  const available = cameras.filter(camera => group[camera]);
  if (!available.length) {
    showNotice('選択したカメラの動画がありません。', 'error');
    return;
  }
  if (available.length !== cameras.length && choice === 'both') {
    showNotice('前後両方を選択しましたが、片方の動画がありません。存在するカメラだけ保存します。', 'error');
  }
  ui['trim-save'].disabled = true;
  try {
    const mode = ui['trim-mode'].value;
    const outputs = await window.miovuer.trimPair(group.id, start, end, available, mode);
    if (outputs?.length) {
      const timing = mode === 'copy'
        ? '映像は再エンコードせず、キーフレーム位置で切り出しました。音声はAACに変換しています。'
        : '指定位置を優先して再エンコードしました。';
      showNotice(`${timing} 保存先: ${outputs.join(' / ')}`, 'success');
    }
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    ui['trim-save'].disabled = false;
  }
}

function openCopyDialog() {
  ui['copy-source'].value = state.root ?? '';
  ui['copy-dialog'].showModal();
}

async function startCopy() {
  const source = ui['copy-source'].value;
  const destination = ui['copy-destination'].value;
  const categories = [...document.querySelectorAll('.copy-categories input:checked')].map(input => input.value);
  if (!source || !destination || !categories.length) {
    ui['copy-status'].textContent = 'コピー元・コピー先・カテゴリーを指定してください';
    return;
  }
  ui['copy-start'].disabled = true;
  ui['copy-status'].textContent = 'コピーを実行しています';
  ui['copy-errors'].textContent = '';
  state.copyErrors = [];
  try {
    const report = await window.miovuer.copyData(source, destination, categories);
    const failures = report.filter(item => item.status === 'error').length;
    ui['copy-status'].textContent = `完了: 検証済み ${report.length - failures}件 / エラー ${failures}件`;
    ui['copy-percent'].textContent = failures ? '要確認' : '完了';
    ui['copy-progress'].value = 100;
    if (failures) ui['copy-errors'].textContent = state.copyErrors.join('\n');
    else showNotice(`コピーとSHA-256検証が完了しました（${report.length}ファイル）。`, 'success');
  } catch (error) {
    ui['copy-status'].textContent = 'コピー中にエラーが発生しました';
    ui['copy-errors'].textContent = error.message;
  } finally {
    ui['copy-start'].disabled = false;
  }
}

window.miovuer.onCopyProgress(({ source, copied, total }) => {
  const percent = total ? Math.floor(copied / total * 100) : 100;
  ui['copy-progress'].value = percent;
  ui['copy-percent'].textContent = `${percent}%`;
  ui['copy-status'].textContent = `${source.split(/[\\/]/).at(-1)} をコピー中`;
});
window.miovuer.onCopyFileComplete(file => {
  ui['copy-status'].textContent = `${file.source.split(/[\\/]/).at(-1)} · SHA-256検証済み`;
  ui['copy-progress'].value = 0;
  ui['copy-percent'].textContent = '次のファイル';
});
window.miovuer.onCopyFileError(file => {
  state.copyErrors.push(`${file.source}: ${file.error}`);
  ui['copy-errors'].textContent = state.copyErrors.join('\n');
});

const detachedViews = new Map();
let closingApplication = false;

async function restorePlayer(group, seconds, wasPlaying) {
  state.loadController?.abort();
  const controller = new AbortController();
  state.loadController = controller;
  try {
    await Promise.all(['front', 'rear'].map(camera =>
      loadVideo(ui[`video-${camera}`], group[camera], ui[`${camera}-empty`], controller.signal)));
    controller.signal.throwIfAborted();
    seekTo(seconds);
    ui['playback-state'].textContent = '一時停止';
    prepareNextRecording();
    if (wasPlaying) await play();
  } catch (error) {
    if (controller.signal.aborted) return;
    pause();
    showNotice(`再生画面を戻せませんでした: ${error.message}`, 'error');
  }
}

function refreshViewSizes() {
  drawChart();
  drawGChart();
  state.map?.invalidateSize();
}

function resetRouteView() {
  state.map?.remove();
  state.map = null;
  state.route = null;
  state.routeId = null;
  state.marker = null;
}

function detachView(id) {
  const existing = detachedViews.get(id);
  if (existing) { existing.window.focus(); return; }
  const panel = document.getElementById(id);
  const button = panel.querySelector('.popout-button');
  const title = panel.querySelector('h2')?.textContent ?? 'プレイバック';
  const child = window.open('about:blank', id, 'width=1200,height=800');
  if (!child) {
    showNotice('別ウィンドウを開けませんでした。', 'error');
    return;
  }
  if (id === 'view-player') cancelCrossfade();
  if (id === 'view-route') resetRouteView();
  const placeholder = document.createElement('section');
  placeholder.className = 'panel detached-placeholder';
  const label = document.createElement('span');
  label.textContent = `${title}は別ウィンドウに表示中です`;
  const focus = document.createElement('button');
  focus.className = 'button button-secondary';
  focus.textContent = 'ウィンドウを表示';
  focus.onclick = () => child.focus();
  const restore = document.createElement('button');
  restore.className = 'button button-secondary';
  restore.textContent = '元の画面へ戻す';
  restore.onclick = () => child.close();
  placeholder.append(label, focus, restore);
  panel.replaceWith(placeholder);
  child.document.title = `${title} — MiVue Vuer`;
  for (const source of document.querySelectorAll('link[rel="stylesheet"]')) {
    const link = child.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = source.href;
    link.onload = refreshViewSizes;
    child.document.head.append(link);
  }
  child.document.body.className = 'detached-view';
  child.document.body.append(panel);
  if (id === 'view-route') {
    const script = child.document.createElement('script');
    script.src = document.querySelector('script[src$="leaflet.js"]').src;
    script.onload = () => { updateMap(); refreshViewSizes(); };
    script.onerror = () => showNotice('別ウィンドウの地図ライブラリを読み込めませんでした。画面を戻して再度開いてください。', 'error');
    child.document.head.append(script);
  }
  button.textContent = '元の画面へ戻す';
  detachedViews.set(id, { window: child });
  child.addEventListener('resize', refreshViewSizes);
  child.addEventListener('beforeunload', () => {
    if (closingApplication) return;
    const group = state.selected;
    const wasPlaying = state.playing;
    const seconds = (group?.front ? ui['video-front'] : ui['video-rear']).currentTime;
    if (id === 'view-player') {
      pause();
      discardPrepared();
    }
    if (id === 'view-route') resetRouteView();
    placeholder.replaceWith(panel);
    if (id === 'view-player') {
      for (const camera of ['front', 'rear']) {
        const old = ui[`video-${camera}`];
        const video = document.createElement('video');
        video.id = old.id;
        video.playsInline = true;
        video.preload = 'auto';
        video.muted = camera === 'rear' || ui['mute-toggle'].textContent === '🔇';
        old.replaceWith(video);
        old.removeAttribute('src');
        old.load();
        ui[`video-${camera}`] = video;
        bindVideoEvents(video);
      }
    }
    button.textContent = '別ウィンドウ ↗';
    detachedViews.delete(id);
    if (id === 'view-route') updateMap();
    requestAnimationFrame(refreshViewSizes);
    if (id === 'view-player' && group) {
      setTimeout(() => {
        if (state.selected === group && panel.ownerDocument === document) {
          restorePlayer(group, seconds, wasPlaying);
        }
      }, 0);
    }
  }, { once: true });
  requestAnimationFrame(refreshViewSizes);
  if (id === 'view-player' && state.playing) play();
}

for (const button of document.querySelectorAll('.popout-button')) {
  button.addEventListener('click', () => {
    const detached = detachedViews.get(button.dataset.view);
    if (detached) detached.window.close();
    else detachView(button.dataset.view);
  });
}
window.addEventListener('beforeunload', () => {
  closingApplication = true;
  for (const { window: child } of detachedViews.values()) child.close();
});

function togglePanel(panelId, buttonId) {
  const panel = ui[panelId];
  panel.hidden = !panel.hidden;
  ui[buttonId].setAttribute('aria-expanded', String(!panel.hidden));
  if (buttonId === 'search-toggle') {
    ui[buttonId].textContent = panel.hidden ? '検索条件を表示' : '検索条件を閉じる';
  }
  requestAnimationFrame(() => {
    drawChart();
    drawGChart();
    state.map?.invalidateSize();
  });
}

ui['search-toggle'].addEventListener('click', () => togglePanel('search-panel', 'search-toggle'));
ui['trim-toggle'].addEventListener('click', () => togglePanel('trim-panel', 'trim-toggle'));
ui['open-source'].addEventListener('click', openSource);
ui['apply-filter'].addEventListener('click', () => { renderRecordList(); prepareNextRecording(); });
for (const input of document.querySelectorAll('.category-filter, .camera-options input')) {
  input.addEventListener('change', () => { renderRecordList(); prepareNextRecording(); });
}
ui['play-toggle'].addEventListener('click', () => state.playing ? pause() : play());
ui['previous'].addEventListener('click', () => moveSelection(-1));
ui['next'].addEventListener('click', () => state.playing ? advanceAfterEnd() : moveSelection(1));
ui['mute-toggle'].addEventListener('click', () => {
  ui['video-front'].muted = !ui['video-front'].muted;
  ui['mute-toggle'].textContent = ui['video-front'].muted ? '🔇' : '🔊';
  if (state.prepared) state.prepared.videos[0].muted = ui['video-front'].muted;
});
ui.seek.addEventListener('input', () => {
  const video = state.selected?.front ? ui['video-front'] : ui['video-rear'];
  if (video && Number.isFinite(video.duration)) seekTo(Number(ui.seek.value) / 1000 * video.duration);
});
function bindVideoEvents(video) {
  video.addEventListener('timeupdate', handleTimeUpdate);
  video.addEventListener('ended', () => {
    const primary = state.selected?.front ? ui['video-front'] : ui['video-rear'];
    if (video === primary && state.playing) advanceAfterEnd();
  });
}
for (const video of [ui['video-front'], ui['video-rear']]) bindVideoEvents(video);
ui['trim-save'].addEventListener('click', saveTrim);
ui['copy-open'].addEventListener('click', openCopyDialog);
ui['copy-close'].addEventListener('click', () => ui['copy-dialog'].close());
ui['choose-copy-source'].addEventListener('click', async () => {
  const root = await window.miovuer.selectRoot();
  if (root) ui['copy-source'].value = root;
});
ui['choose-copy-destination'].addEventListener('click', async () => {
  const root = await window.miovuer.selectDestination();
  if (root) ui['copy-destination'].value = root;
});
ui['copy-start'].addEventListener('click', startCopy);
ui['open-map'].addEventListener('click', async () => {
  if (state.currentPosition) {
    const { latitude, longitude } = state.currentPosition;
    await window.miovuer.openExternal(`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`);
  }
});
window.addEventListener('resize', () => { drawChart(); drawGChart(); });

if (window.L) {
  window.L.Icon.Default.imagePath = '../node_modules/leaflet/dist/images/';
}
