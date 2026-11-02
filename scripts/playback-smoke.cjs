const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'Data'));
const watchdog = setTimeout(() => {
  console.error('Playback smoke test exceeded 300 seconds');
  app.exit(1);
}, 300000);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

let mainWindowObserved = false;
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited:', details));
  if (mainWindowObserved) return;
  mainWindowObserved = true;
  window.webContents.on('console-message', event => {
    console.log(`renderer: ${event.message}`);
    if (event.message === 'Detached playback and preload ready') {
      for (const child of BrowserWindow.getAllWindows()) {
        if (child.getTitle().startsWith('プレイバック') || child.getTitle().includes('2026')) {
          child.show();
          child.focus();
        }
      }
    }
  });
  window.webContents.once('did-finish-load', async () => {
    let exitCode = 1;
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        if (getComputedStyle(ui['library-panel']).display === 'none' ||
            getComputedStyle(ui['search-panel']).display !== 'none' ||
            getComputedStyle(ui['trim-panel']).display !== 'none') {
          throw new Error('Optional panels must start hidden');
        }
        ui['search-toggle'].click();
        ui['trim-toggle'].click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (getComputedStyle(ui['library-panel']).display === 'none' ||
            getComputedStyle(ui['trim-panel']).display === 'none' ||
            getComputedStyle(ui['search-panel']).display === 'none' ||
            ui['search-toggle'].getAttribute('aria-expanded') !== 'true') {
          throw new Error('Optional panels did not open');
        }
        ui['trim-start'].value = '2';
        ui['trim-toggle'].click();
        if (ui['trim-start'].value !== '2' || !ui['trim-panel'].hidden) {
          throw new Error('Closing trim panel lost input state');
        }
        await openSource();
        if (!state.groups.length) throw new Error(ui.notice.textContent);
        const autoStarted = state.playing &&
          !ui['video-front'].paused && !ui['video-rear'].paused;
        if (!autoStarted) throw new Error('Opening the folder did not start playback automatically');
        for (const id of ['view-player', 'view-telemetry', 'view-route']) detachView(id);
        await new Promise(resolve => setTimeout(resolve, 500));
        if (detachedViews.size !== 3 ||
            document.getElementById('view-player') !== null ||
            ui['video-front'].ownerDocument === document) {
          throw new Error('Views were not detached into independent windows');
        }
        const filterBefore = ui['filter-front'].checked;
        ui['search-toggle'].click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!state.playing || ui['library-panel'].hidden || !ui['search-panel'].hidden ||
            ui['filter-front'].checked !== filterBefore) {
          throw new Error('Closing search changed the library, filters, or playback: ' + ui.notice.textContent);
        }
        const sensorPoints = state.selected.acceleration;
        if (!sensorPoints?.length || ui['g-x'].textContent === '--' ||
            ui['g-chart'].width === 0) throw new Error('G chart did not render without GPS');
        seekTo(1);
        const expectedSensor = sensorPoints.reduce((best, point) =>
          Math.abs(point.offset - 1) < Math.abs(best.offset - 1) ? point : best);
        if (ui['g-x'].textContent !== expectedSensor.x.toFixed(3) ||
            ui['g-y'].textContent !== expectedSensor.y.toFixed(3) ||
            ui['g-z'].textContent !== expectedSensor.z.toFixed(3)) {
          throw new Error('G chart values did not follow seeking');
        }
        pause();
        const firstRow = ui['record-list'].querySelector('.record-row');
        firstRow.click();
        detachedViews.get('view-player').window.focus();
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            clearInterval(timer);
            reject(new Error('Selecting a recording did not start playback automatically'));
          }, 10000);
          const timer = setInterval(() => {
            if (!state.playing || ui['video-front'].paused || ui['video-rear'].paused) return;
            clearInterval(timer);
            clearTimeout(timeout);
            resolve();
          }, 10);
        });
        if (!state.prepared || !await state.prepared.promise) {
          throw new Error('Next recording was not preloaded');
        }
        console.log('Detached playback and preload ready');
        const nextId = state.prepared.group.id;
        const nextVideos = [...state.prepared.videos];
        const oldPrimary = state.selected.front ? ui['video-front'] : ui['video-rear'];
        const preparedBeforeEnd = !oldPrimary.ended &&
          state.prepared.videos.every(video => video.readyState >= 2);
        let endedAt;
        let firstFrameDelayMs;
        const audioOverlap = [];
        const audioSampler = setInterval(() => {
          if (state.crossfade?.running) {
            audioOverlap.push({
              outgoingVolume: oldPrimary.volume,
              incomingVolume: nextVideos[0].volume,
              outgoingPlaying: !oldPrimary.paused && !oldPrimary.ended,
              incomingPlaying: !nextVideos[0].paused,
              incomingMuted: nextVideos[0].muted
            });
          }
        }, 5);
        oldPrimary.addEventListener('ended', () => { endedAt = performance.now(); }, { once: true });
        seekTo(oldPrimary.duration - 0.6);
        await new Promise((resolve, reject) => {
          const frameTimeout = setTimeout(() => reject(new Error('Next frame timed out: ' +
            JSON.stringify({ status: ui['playback-state'].textContent,
              paused: ui['video-front'].paused, time: ui['video-front'].currentTime,
              frames: ui['video-front'].getVideoPlaybackQuality().totalVideoFrames,
              visibility: ui['video-front'].ownerDocument.visibilityState,
              hidden: ui['video-front'].hidden,
              size: ui['video-front'].getBoundingClientRect().toJSON(),
              notice: ui.notice.textContent }))), 15000);
          const timeout = setTimeout(() => {
            clearInterval(timer);
            reject(new Error('Automatic transition timed out'));
          }, 10000);
          const timer = setInterval(() => {
            if (state.selected.id !== nextId || !state.playing) return;
            clearInterval(timer);
            clearTimeout(timeout);
            const primary = state.selected.front ? ui['video-front'] : ui['video-rear'];
            primary.requestVideoFrameCallback(() => {
              firstFrameDelayMs = performance.now() - endedAt;
              clearTimeout(frameTimeout);
              resolve();
            });
          }, 10);
        });
        const videos = [ui['video-front'], ui['video-rear']];
        clearInterval(audioSampler);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const details = videos.map(video => ({
          source: video.currentSrc,
          readyState: video.readyState,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
          h264: video.canPlayType('video/mp4; codecs="avc1.640033"'),
          width: video.videoWidth,
          height: video.videoHeight,
          time: video.currentTime,
          frames: video.getVideoPlaybackQuality().totalVideoFrames,
          paused: video.paused
        }));
        const overlays = [ui['front-empty'], ui['rear-empty']].map(element => ({
          hidden: element.hidden,
          display: getComputedStyle(element).display
        }));
        const driftSeconds = Math.abs(videos[0].currentTime - videos[1].currentTime);
        const usedPreloadedVideos = videos.every((video, index) => video === nextVideos[index]);
        const status = ui['playback-state'].textContent;
        const transitions = [];
        for (let index = 0; index < 4; index += 1) {
          const prepared = state.prepared;
          if (!prepared || !await prepared.promise) throw new Error('Preload failed: ' + ui.notice.textContent);
          const expected = prepared.group.id;
          const primary = state.selected.front ? ui['video-front'] : ui['video-rear'];
          seekTo(primary.duration - 0.4);
          await new Promise((resolve, reject) => {
            const started = performance.now();
            const timer = setInterval(() => {
              if (state.selected.id === expected && state.playing &&
                  !ui['video-front'].paused && !ui['video-rear'].paused) {
                clearInterval(timer);
                resolve();
              } else if (performance.now() - started > 10000) {
                clearInterval(timer);
                reject(new Error('Transition failed: ' + ui['playback-state'].textContent + ': ' + ui.notice.textContent));
              }
            }, 20);
          });
          await new Promise(resolve => setTimeout(resolve, 300));
          transitions.push({ id: state.selected.id, status: ui['playback-state'].textContent });
        }
        for (const { window: child } of [...detachedViews.values()]) child.close();
        await new Promise((resolve, reject) => {
          const started = performance.now();
          const timer = setInterval(() => {
            if (state.playing && state.prepared?.ready && !ui['video-front'].paused) {
              clearInterval(timer);
              resolve();
            } else if (performance.now() - started > 15000) {
              clearInterval(timer);
              reject(new Error('Restored playback did not resume: ' + ui.notice.textContent));
            }
          }, 20);
        });
        if (detachedViews.size || ui['video-front'].ownerDocument !== document ||
            !document.getElementById('view-telemetry') || !document.getElementById('view-route')) {
          throw new Error('Closing detached windows did not restore their views');
        }
        const finalVideos = [ui['video-front'], ui['video-rear']];
        const upcoming = state.prepared;
        if (!upcoming || !await upcoming.promise) throw new Error('Final preload failed');
        const finalPrimary = state.selected.front ? finalVideos[0] : finalVideos[1];
        seekTo(finalPrimary.duration - 0.09);
        await new Promise((resolve, reject) => {
          const started = performance.now();
          const timer = setInterval(() => {
            if (state.crossfade?.running) {
              clearInterval(timer);
              ui['mute-toggle'].click();
              const bothMuted = finalVideos[0].muted && upcoming.videos[0].muted;
              pause();
              const fadeCancelled = state.crossfade === null &&
                upcoming.videos.every(video => video.paused && video.muted && video.volume === 1) &&
                finalVideos[0].volume === 1;
              ui['mute-toggle'].click();
              if (!bothMuted || !fadeCancelled) reject(new Error('Mute or pause failed during crossfade'));
              else resolve();
            } else if (performance.now() - started > 2000) {
              clearInterval(timer);
              reject(new Error('Crossfade cancellation test timed out: ' + JSON.stringify({
                paused: finalPrimary.paused, time: finalPrimary.currentTime, duration: finalPrimary.duration,
                ready: state.prepared?.ready, error: state.prepared?.error?.message,
                notice: ui.notice.textContent
              })));
            }
          }, 1);
        });
        pause();
        const pausedTimes = finalVideos.map(video => video.currentTime);
        await new Promise(resolve => setTimeout(resolve, 200));
        const pauseWorks = finalVideos.every((video, index) => video.paused &&
          Math.abs(video.currentTime - pausedTimes[index]) < 0.05);
        const gpsGroup = state.groups.find(group => group.gps?.length > 5);
        if (!gpsGroup) throw new Error('GPS sample required for detached route test');
        await selectRecording(gpsGroup, false);
        for (const id of ['view-player', 'view-telemetry', 'view-route']) {
          document.querySelector('[data-view="' + id + '"]').click();
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!state.map || !detachedViews.get('view-route').window.L ||
            state.map.getContainer().ownerDocument === document) {
          throw new Error('Detached route was not initialized in its own document');
        }
        seekTo(3);
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!state.currentPosition ||
            Math.abs(state.marker.getLatLng().lat - state.currentPosition.latitude) > 0.000001 ||
            ui['g-chart'].getBoundingClientRect().height <= 100) {
          throw new Error('Detached route or enlarged telemetry did not follow seeking');
        }
        const mapWindow = ui.map.ownerDocument.defaultView;
        const centerBefore = state.map.getCenter();
        const bounds = ui.map.getBoundingClientRect();
        const target = state.map.getPane('mapPane');
        const mouseDown = new mapWindow.MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: 0, buttons: 1,
          clientX: bounds.x + 200, clientY: bounds.y + 200
        });
        Object.defineProperty(mouseDown, 'which', { value: 1 });
        target.dispatchEvent(mouseDown);
        ui.map.dispatchEvent(new mapWindow.MouseEvent('mousemove', {
          bubbles: true, buttons: 1, clientX: bounds.x + 300, clientY: bounds.y + 240
        }));
        await new Promise(resolve => setTimeout(resolve, 100));
        ui.map.dispatchEvent(new mapWindow.MouseEvent('mousemove', {
          bubbles: true, buttons: 1, clientX: bounds.x + 400, clientY: bounds.y + 280
        }));
        mapWindow.document.dispatchEvent(new mapWindow.MouseEvent('mouseup', {
          bubbles: true, button: 0, clientX: bounds.x + 400, clientY: bounds.y + 280
        }));
        await new Promise(resolve => setTimeout(resolve, 300));
        if (state.map.getCenter().equals(centerBefore)) throw new Error('Detached map dragging did not work: ' +
          JSON.stringify({ moved: state.map.dragging._draggable._moved,
            start: state.map.dragging._draggable._startPoint,
            transform: target.style.transform, localLibrary: mapWindow.L !== window.L,
            dragging: state.map.dragging.enabled() }));
        for (const { window: child } of [...detachedViews.values()]) {
          child.document.querySelector('.popout-button').click();
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (detachedViews.size || state.playing || !ui['video-front'].paused ||
            !state.map || ui.map.ownerDocument !== document) {
          throw new Error('Repeated restore lost paused state or map');
        }
        return { status, notice: ui.notice.textContent, details, overlays, driftSeconds,
          usedPreloadedVideos, firstFrameDelayMs, pauseWorks, autoStarted, preparedBeforeEnd, transitions,
          audioOverlap: {
            samples: audioOverlap.length,
            rampVerified: audioOverlap.some(sample => sample.outgoingPlaying && sample.incomingPlaying &&
              !sample.incomingMuted && sample.outgoingVolume > 0 && sample.outgoingVolume < 1 &&
              sample.incomingVolume > 0 && sample.incomingVolume < 1),
            pauseAndMuteVerified: true
          }, detachedViewsVerified: true };
      })()`);
      console.log(JSON.stringify(result, null, 2));
      exitCode = result.status === '再生中' &&
        result.details.every(video => video.frames > 0 && !video.paused && !video.error) &&
        result.overlays.every(overlay => overlay.display === 'none') &&
        result.driftSeconds < 0.35 && result.usedPreloadedVideos &&
        result.firstFrameDelayMs < 250 && result.pauseWorks &&
        result.autoStarted && result.preparedBeforeEnd &&
        result.audioOverlap.rampVerified && result.audioOverlap.pauseAndMuteVerified ? 0 : 1;
    } catch (error) {
      console.error(error);
    } finally {
      clearTimeout(watchdog);
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      app.exit(exitCode);
    }
  });
});

require('../src/main');
