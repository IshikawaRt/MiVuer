const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'Data'));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', event => {
    console.log(`renderer: ${event.message}`);
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
        const filterBefore = ui['filter-front'].checked;
        ui['search-toggle'].click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!state.playing || ui['library-panel'].hidden || !ui['search-panel'].hidden ||
            ui['filter-front'].checked !== filterBefore) {
          throw new Error('Closing search changed the library, filters, or playback');
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
              reject(new Error('Crossfade cancellation test timed out'));
            }
          }, 1);
        });
        pause();
        const pausedTimes = finalVideos.map(video => video.currentTime);
        await new Promise(resolve => setTimeout(resolve, 200));
        const pauseWorks = finalVideos.every((video, index) => video.paused &&
          Math.abs(video.currentTime - pausedTimes[index]) < 0.05);
        return { status, notice: ui.notice.textContent, details, overlays, driftSeconds,
          usedPreloadedVideos, firstFrameDelayMs, pauseWorks, autoStarted, preparedBeforeEnd, transitions,
          audioOverlap: {
            samples: audioOverlap.length,
            rampVerified: audioOverlap.some(sample => sample.outgoingPlaying && sample.incomingPlaying &&
              !sample.incomingMuted && sample.outgoingVolume > 0 && sample.outgoingVolume < 1 &&
              sample.incomingVolume > 0 && sample.incomingVolume < 1),
            pauseAndMuteVerified: true
          } };
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
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      app.exit(exitCode);
    }
  });
});

require('../src/main');
