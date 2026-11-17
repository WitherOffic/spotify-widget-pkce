/*
 * Spotify Widget — PKCE Edition (2026)
 * Based on nuttylmao/spotify-widget (GPL-3.0).
 * No SMTC, client secret, service worker, proxy, or resident companion app.
 * Needs static HTTPS hosting + a Spotify Developer application owned by the user.
 */
import {
  DEFAULT_POLL_MS, parsePollMs, retryAfterMs, normalizeTrack,
  progressAt, formatTime, clamp, getOAuthErrorMessage,
} from './player-core.js';
import { createTextTransition } from './src/track-animation.js';
import { createArtworkController } from './src/artwork.js';
import { SpotifyAuth } from './src/spotify-auth.js';

const params = new URLSearchParams(window.location.search);
const OPTIONS_KEY='nutty-pkce-v1-options'; // Preserve existing browser configuration.
const API_CURRENT='https://api.spotify.com/v1/me/player/currently-playing';
const defaultRedirect = new URL('./index.html', window.location.href);
defaultRedirect.search = '';
defaultRedirect.hash = '';
const redirectUri = defaultRedirect.toString();

const els = {
  main: document.getElementById('mainContainer'),
  panel: document.getElementById('statusContainer'),
  status: document.getElementById('statusMessage'),
  clientInput: document.getElementById('clientIdInput'),
  redirect: document.getElementById('redirectUriText'),
  connect: document.getElementById('connectButton'),
  disconnect: document.getElementById('disconnectButton'),
  exportButton: document.getElementById('exportButton'),
  importButton: document.getElementById('importButton'),
  transferInput: document.getElementById('transferInput'),
  art: document.getElementById('albumArt'),
  artBack: document.getElementById('albumArtBack'),
  bg: document.getElementById('backgroundImage'),
  bgBack: document.getElementById('backgroundImageBack'),
  trackText: document.getElementById('trackText'),
  trackViewport: document.getElementById('trackTextViewport'),
  song: document.getElementById('songLabel'),
  artist: document.getElementById('artistLabel'),
  progress: document.getElementById('progressBar'),
  elapsed: document.getElementById('progressTime'),
  remaining: document.getElementById('timeRemaining'),
};
const auth = new SpotifyAuth({redirectUri});
const configId = params.get('client_id')?.trim() || '';
if (/^[a-zA-Z0-9]{16,64}$/.test(configId)) auth.setClientId(configId);
let clientId = auth.clientId;
// Preserve options across the OAuth redirect, which returns only ?code=...&state=....
let storedOptions = {};
try { storedOptions = JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}') || {}; }
catch { storedOptions = {}; }
const isOAuthCallback = params.has('code') || params.has('error');
const options = isOAuthCallback ? storedOptions : {
  poll: params.get('poll') ?? DEFAULT_POLL_MS,
  duration: params.get('duration') ?? '0',
  hideAlbumArt: params.has('hideAlbumArt'),
  settings: params.get('settings') === '1',
};
if (!isOAuthCallback && params.get('demo') !== '1') localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
const pollMs = parsePollMs(options.poll);
const visibilityDuration = clamp(Number(options.duration) || 0, 0, 3600) * 1000;
const hideAlbumArt = !!options.hideAlbumArt;
const debug = !!options.settings;
let active = false;
let pollTimer = null;
let visibilityTimer = null;
let ticker = null;
let currentTrack = null;
let lastTrackId = null;
let trackSampledAt = 0;
let failureCount = 0;
let wasPlaying = false;
let currentVisible = false;
let rateLimitedUntil = 0;
function noteRateLimit(response) {
  const wait = retryAfterMs(response.headers.get('Retry-After')) ?? 60000;
  rateLimitedUntil = Math.max(rateLimitedUntil,Date.now()+Math.max(1000,wait));
  return wait;
}
const artworkController = createArtworkController({
  container: els.main,
  images: [els.art, els.artBack, els.bg, els.bgBack],
  request: url => authorizedFetch(url),
  isRateLimited: () => Date.now() < rateLimitedUntil,
  noteRateLimit,
});
// Visual transitions do not affect the playback clock or API polling.
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const animatedText = !reducedMotion && !params.has('noAnimation');
const textTransition = createTextTransition(els.trackViewport, els.song, els.artist, { enabled: animatedText });

// Display helpers.
function setVisibility(visible) {
  if (currentVisible === visible) return;
  currentVisible = visible;
  els.main.style.opacity = visible ? '1' : '0';
  els.main.style.bottom = visible ? '50%' : 'calc(50% - 20px)';
}
function clearVisibilityTimer() {
  if (visibilityTimer) clearTimeout(visibilityTimer);
  visibilityTimer = null;
}
function revealForTrack() {
  clearVisibilityTimer();
  setVisibility(true);
  if (visibilityDuration > 0) visibilityTimer = setTimeout(() => setVisibility(false), visibilityDuration);
}
function hideTrack() {
  clearVisibilityTimer();
  textTransition.cancel();
  currentTrack = null;
  lastTrackId = null;
  wasPlaying = false;
  artworkController.clear();
  setVisibility(false);
}
function showStatus(message) {
  if (message) els.status.textContent = message;
  els.panel.hidden = false;
  els.clientInput.value = clientId;
}
function hideStatus() {
  if (!debug) els.panel.hidden = true;
}
function drawProgress() {
  if (!currentTrack) return;
  const progress = progressAt(currentTrack, performance.now() - trackSampledAt);
  const duration = currentTrack.durationMs;
  els.progress.style.width = `${duration > 0 ? (progress / duration) * 100 : 0}%`;
  els.elapsed.textContent = formatTime(progress);
  els.remaining.textContent = `-${formatTime(duration - progress)}`;
}
function renderPlaying(data, responseRoundTripMs = 0) {
  const track = normalizeTrack(data);
  if (!track) { hideTrack(); return; }
  const newTrack = track.id !== lastTrackId;
  currentTrack = track;
  // Resynchronize on every API response, correcting drift and seeking.
  // Half the measured round trip approximates the age of the returned snapshot.
  trackSampledAt = performance.now() - Math.min(Math.max(responseRoundTripMs / 2, 0), 750);
  if (newTrack) {
    textTransition.animate(track.title, track.artist, Boolean(lastTrackId));
    lastTrackId = track.id;
    artworkController.clear(); // Never carry over a previous song's cover.
  }
  void artworkController.display(track.id, data.item, track.image);
  drawProgress();
  if (newTrack || !wasPlaying) revealForTrack();
  wasPlaying = true;
}
async function connectSpotify() {
  clientId = els.clientInput.value.trim();
  return auth.startConnect(clientId);
}
async function processOAuthCallback() {
  const connected=await auth.completeRedirect(params);
  clientId=auth.clientId;
  return connected;
}
async function authorizedFetch(url) {
  return auth.authorizedFetch(url);
}
async function fetchCurrentlyPlaying() {
  return authorizedFetch(API_CURRENT);
}
async function poll() {
  if (!active) return;
  let delay = pollMs;
  try {
    // Share the 429 cooldown with catalog artwork lookups.
    if (Date.now() < rateLimitedUntil) {
      delay = Math.max(pollMs, rateLimitedUntil - Date.now());
      return;
    }
    const requestStartedAt = performance.now();
    const response = await fetchCurrentlyPlaying();
    const roundTripMs = performance.now() - requestStartedAt;
    if (response.status === 204) {
      hideTrack(); // Spotify has no active playback
      hideStatus();
      failureCount = 0;
    } else if (response.ok) {
      const data = await response.json();
      renderPlaying(data, roundTripMs);
      hideStatus();
      failureCount = 0;
    } else if (response.status === 429) {
      // Honour Retry-After and avoid hitting developer quota harder.
      const retryMs = noteRateLimit(response);
      delay = Math.max(pollMs, retryMs);
      console.warn(`Spotify 429 — next request in ${Math.ceil(delay / 1000)} seconds.`);
    } else if (response.status === 401 || response.status === 403) {
      const details = await response.text().catch(() => '');
      throw new FatalError(getOAuthErrorMessage(response.status, details));
    } else if (response.status >= 500) {
      failureCount++;
      delay = Math.min(300000, Math.max(pollMs, 10000 * 2 ** Math.min(failureCount, 5)));
      console.warn(`Spotify returned ${response.status}; retry in ${delay}ms.`);
    } else {
      const details = await response.text().catch(() => '');
      throw new FatalError(getOAuthErrorMessage(response.status, details));
    }
  } catch (error) {
    if (error instanceof FatalError || !auth.hasSession) {
      console.error('Spotify Widget:', error.message);
      active = false;
      hideTrack();
      showStatus(error.message);
      return;
    }
    failureCount++;
    delay = Math.min(300000, Math.max(pollMs, 10000 * 2 ** Math.min(failureCount, 5)));
    console.warn(`Spotify Widget network/token error: ${error.message}. Retry in ${delay} ms.`);
    if (failureCount >= 3 && debug) showStatus('Нет соединения со Spotify. Повторяем запрос с увеличенным интервалом.');
  } finally {
    if (active) pollTimer = setTimeout(poll, delay);
  }
}
class FatalError extends Error {}
function exportConnection() {
  try {
    els.transferInput.value = JSON.stringify(auth.exportConnection());
    els.transferInput.focus();
    els.transferInput.select();
    showStatus('Скопируй JSON подключения и перенеси в OBS. Не публикуй и не передавай токен.');
  } catch(error) { showStatus(error.message); }
}
function importConnection() {
  try {
    auth.importConnection(els.transferInput.value);
    clientId=auth.clientId;
    els.transferInput.value='';
    els.clientInput.value=clientId;
    showStatus('Подключение импортировано. Проверяем Spotify API...');
    if (!active) { active=true; poll(); }
  } catch(error) { showStatus(`Ошибка импорта: ${error.message}`); }
}
function disconnect() {
  active=false;
  if(pollTimer) clearTimeout(pollTimer);
  clearVisibilityTimer();
  auth.disconnect();
  hideTrack();
  els.transferInput.value='';
  showStatus('Авторизация сброшена.');
}
function resize() {
  const maxWidth = 550; // original design's approximately 500px body + margins
  const scale = Math.min(2.2, Math.max(.2, window.innerWidth / maxWidth));
  els.main.style.transform = `translate(-50%, 50%) scale(${scale})`;
}
async function start() {
  els.redirect.textContent = redirectUri;
  els.clientInput.value = clientId;
  els.connect.addEventListener('click', () => connectSpotify().catch(e => showStatus(e.message)));
  els.disconnect.addEventListener('click', disconnect);
  els.exportButton.addEventListener('click', exportConnection);
  els.importButton.addEventListener('click', importConnection);
  if (hideAlbumArt) {
    document.getElementById('albumArtBox').style.display = 'none';
    document.getElementById('songInfoBox').style.width = 'calc(100% - 20px)';
    els.main.style.maxWidth = '400px';
  }
  window.addEventListener('resize', resize);
  resize();
  setVisibility(false);
  els.main.style.opacity = '0';
  ticker = setInterval(drawProgress, 250);
  artworkController.clear();

  if (params.get('demo') === '1') {
    const demoTracks = [
      ['Демонстрационный трек', 'Тестовый исполнитель'],
      ['Следующая композиция', 'Другой исполнитель'],
      ['Ещё одна песня', 'Исполнитель № 3'],
    ];
    let demoIndex = 0;
    const showDemoTrack = index => {
      const [name, artist] = demoTracks[index];
      renderPlaying({
        is_playing: true, progress_ms: 7000, currently_playing_type: 'track',
        item: {
          uri: `spotify:track:demo-${index}`, type: 'track',
          name, duration_ms: 180000,
          artists: [{ name: artist }], album: { images: [] },
        },
      });
    };
    showDemoTrack(demoIndex);
    setInterval(() => {
      demoIndex = (demoIndex + 1) % demoTracks.length;
      showDemoTrack(demoIndex);
    }, 6500);
    hideStatus();
    return;
  }
  if (!window.isSecureContext) {
    showStatus('Для OAuth необходим HTTPS. Файлы надо разместить на GitHub Pages или другом HTTPS-хостинге.');
    return;
  }
  try { await processOAuthCallback(); }
  catch (e) { showStatus(`Ошибка подключения: ${e.message}`); return; }
  if (!auth.hasSession) {
    showStatus('Вставь Client ID и подключи Spotify. Секретный ключ не нужен.');
    return;
  }
  if (debug) showStatus('Режим настроек. Для скрытия этой панели удали ?settings=1 из URL.');
  active = true;
  poll();
}
start().catch(error => showStatus(error.message));
