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
        await openSource();
        if (!state.groups.length) throw new Error(ui.notice.textContent);
        await Promise.all([
          selectRecording(state.groups[0]),
          selectRecording(state.groups[0])
        ]);
        const videos = [ui['video-front'], ui['video-rear']];
        await play();
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
        return { status: ui['playback-state'].textContent, notice: ui.notice.textContent, details, overlays, driftSeconds };
      })()`);
      console.log(JSON.stringify(result, null, 2));
      exitCode = result.status === '再生中' &&
        result.details.every(video => video.frames > 0 && !video.paused && !video.error) &&
        result.overlays.every(overlay => overlay.display === 'none') &&
        result.driftSeconds < 0.35 ? 0 : 1;
    } catch (error) {
      console.error(error);
    } finally {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      app.exit(exitCode);
    }
  });
});

require('../src/main');
