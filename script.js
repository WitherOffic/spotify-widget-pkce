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

const params = new URLSearchParams(window.location.search);
const KEYS = {
  clientId: 'nutty-pkce-v1-client-id',
  tokens: 'nutty-pkce-v1-tokens',
  verifier: 'nutty-pkce-v1-verifier',
  state: 'nutty-pkce-v1-state',
  options: 'nutty-pkce-v1-options',
};
const API_CURRENT = 'https://api.spotify.com/v1/me/player/currently-playing';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const OAUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
const SCOPE = 'user-read-currently-playing';
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
  song: document.getElementById('songLabel'),
  artist: document.getElementById('artistLabel'),
  progress: document.getElementById('progressBar'),
  elapsed: document.getElementById('progressTime'),
  remaining: document.getElementById('timeRemaining'),
};
const configId = params.get('client_id')?.trim() || '';
if (configId) localStorage.setItem(KEYS.clientId, configId);
let clientId = configId || localStorage.getItem(KEYS.clientId) || '';
// Preserve options across the OAuth redirect, which returns only ?code=...&state=....
let storedOptions = {};
try { storedOptions = JSON.parse(localStorage.getItem(KEYS.options) || '{}') || {}; }
catch { storedOptions = {}; }
const isOAuthCallback = params.has('code') || params.has('error');
const options = isOAuthCallback ? storedOptions : {
  poll: params.get('poll') ?? DEFAULT_POLL_MS,
  duration: params.get('duration') ?? '0',
  hideAlbumArt: params.has('hideAlbumArt'),
  settings: params.get('settings') === '1',
};
if (!isOAuthCallback && params.get('demo') !== '1') localStorage.setItem(KEYS.options, JSON.stringify(options));
const pollMs = parsePollMs(options.poll);
const visibilityDuration = clamp(Number(options.duration) || 0, 0, 3600) * 1000;
const hideAlbumArt = !!options.hideAlbumArt;
const debug = !!options.settings;
let tokens = safeReadTokens();
let refreshPromise = null;
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
let displayedArtwork = null;
const artworkCache = new Map();
const ARTWORK_RETRY_MS = 60000;
let rateLimitedUntil = 0;

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
  currentTrack = null;
  lastTrackId = null;
  wasPlaying = false;
  displayedArtwork = null;
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
function updateText(el, value) {
  if (el.textContent === value) return;
  el.classList.add('text-fade');
  clearTimeout(el._textTimeout);
  el._textTimeout = setTimeout(() => {
    el.textContent = value; // never innerHTML: Spotify content is untrusted
    el.classList.remove('text-fade');
  }, 200);
}
function updateImage(front, back, url) {
  const target = /^https:\/\//i.test(url || '') ? url : './images/placeholder.svg';
  if (front.dataset.currentUrl === target) return;
  front.dataset.currentUrl = target;
  front.classList.add('text-fade');
  clearTimeout(front._swapTimeout);
  clearTimeout(front._backTimeout);
  front._swapTimeout = setTimeout(() => {
    front.src = target;
    front.classList.remove('text-fade');
  }, 250);
  front._backTimeout = setTimeout(() => { back.src = target; }, 850);
}
// Spotify can return track data without album.images. Lookup artwork by track/album
// ID using the supported individual catalog endpoints, only once per song.
function imageUrlFrom(item) {
  for (const images of [item?.album?.images, item?.images, item?.show?.images]) {
    if (Array.isArray(images)) {
      const image = images.find(entry => /^https:\/\//i.test(entry?.url || ''));
      if (image) return image.url;
    }
  }
  return null;
}
function displayArtwork(url) {
  const target = /^https:\/\//i.test(url || '') ? url : null;
  if (target === displayedArtwork) return;
  displayedArtwork = target;
  updateImage(els.art, els.artBack, target);
  updateImage(els.bg, els.bgBack, target);
}
function spotifyId(item) {
  const id = item?.id || (typeof item?.uri === 'string' ? item.uri.split(':')[2] : '');
  return /^[a-zA-Z0-9]{22}$/.test(id || '') ? id : null;
}
function noteRateLimit(response) {
  const interval = retryAfterMs(response.headers.get('Retry-After')) ?? 60000;
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + Math.max(1000, interval));
  return interval;
}
async function fetchCatalog(path) {
  if (Date.now() < rateLimitedUntil) return null;
  const request = token => fetch(`https://api.spotify.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  let response = await request(await accessToken());
  if (response.status === 401) response = await request(await accessToken(true));
  if (response.status === 429) {
    noteRateLimit(response);
    return null;
  }
  if (!response.ok) {
    console.warn(`Spotify artwork lookup failed: ${path.split('/')[0]}, HTTP ${response.status}`);
    return null;
  }
  return response.json();
}
async function lookupArtwork(item) {
  if (item?.is_local) return null;
  const albumId = spotifyId(item?.album);
  if (albumId) {
    const album = await fetchCatalog(`albums/${albumId}`);
    const url = imageUrlFrom(album);
    if (url) return url;
  }
  const id = spotifyId(item);
  if (!id) return null;
  const kind = item?.type === 'episode' ? 'episodes' : 'tracks';
  const metadata = await fetchCatalog(`${kind}/${id}`);
  return imageUrlFrom(metadata);
}
async function ensureArtwork(trackId, item) {
  const cached = artworkCache.get(trackId);
  if (cached && (cached.pending || cached.url || Date.now() - cached.checkedAt < ARTWORK_RETRY_MS)) {
    if (cached.url && currentTrack?.id === trackId) displayArtwork(cached.url);
    return;
  }
  artworkCache.set(trackId, { pending: true, url: null, checkedAt: Date.now() });
  try {
    const url = await lookupArtwork(item);
    artworkCache.set(trackId, { pending: false, url, checkedAt: Date.now() });
    if (url && currentTrack?.id === trackId) displayArtwork(url);
    if (!url) console.warn('Spotify has not provided album artwork for this song.');
  } catch (error) {
    artworkCache.set(trackId, { pending: false, url: null, checkedAt: Date.now() });
    console.warn('Spotify artwork lookup error:', error.message);
  }
  if (artworkCache.size > 80) artworkCache.delete(artworkCache.keys().next().value);
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
    updateText(els.song, track.title);
    updateText(els.artist, track.artist);
    lastTrackId = track.id;
    displayedArtwork = ''; // Make even a missing image reset the previous cover.
  }
  const artwork = track.image || artworkCache.get(track.id)?.url || null;
  displayArtwork(artwork);
  if (!artwork) void ensureArtwork(track.id, data.item);
  drawProgress();
  if (newTrack || !wasPlaying) revealForTrack();
  wasPlaying = true;
}
function safeReadTokens() {
  try { return JSON.parse(localStorage.getItem(KEYS.tokens) || 'null'); }
  catch { return null; }
}
function saveTokens(incoming) {
  if (!incoming?.access_token || !Number.isFinite(Number(incoming.expires_in))) {
    throw new Error('Spotify прислал некорректный ответ при обновлении токена.');
  }
  const refresh = incoming.refresh_token || tokens?.refresh_token;
  if (!refresh) throw new Error('В ответе Spotify отсутствует refresh_token. Повтори авторизацию.');
  tokens = {
    access_token: incoming.access_token,
    refresh_token: refresh,
    expires_at: Date.now() + Number(incoming.expires_in) * 1000,
  };
  localStorage.setItem(KEYS.tokens, JSON.stringify(tokens));
}
function discardTokens() {
  tokens = null;
  localStorage.removeItem(KEYS.tokens);
}
async function requestToken(body) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = result.error_description || result.error || response.statusText;
    const error = new Error(`Spotify OAuth (${response.status}): ${reason}`);
    error.code = result.error;
    throw error;
  }
  return result;
}
function randomBase64Url(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...values))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function pkceChallenge(verifier) {
  const bytes = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function connectSpotify() {
  clientId = els.clientInput.value.trim();
  if (!/^[a-zA-Z0-9]{16,64}$/.test(clientId)) {
    showStatus('Вставь корректный Spotify Client ID из Developer Dashboard (не Client Secret).');
    return;
  }
  if (!window.isSecureContext || !crypto?.subtle) {
    showStatus('OAuth PKCE требует HTTPS. Опубликуй файлы через GitHub Pages/другой HTTPS-хостинг. file:// не подходит.');
    return;
  }
  localStorage.setItem(KEYS.clientId, clientId);
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(32);
  sessionStorage.setItem(KEYS.verifier, verifier);
  sessionStorage.setItem(KEYS.state, state);
  const challenge = await pkceChallenge(verifier);
  const url = new URL(OAUTH_ENDPOINT);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId,
    scope: SCOPE, redirect_uri: redirectUri,
    state, code_challenge_method: 'S256', code_challenge: challenge,
  }).toString();
  window.location.assign(url.toString()); // same tab: required by OBS Interact
}
async function processOAuthCallback() {
  if (!params.has('code') && !params.has('error')) return false;
  const expectedState = sessionStorage.getItem(KEYS.state);
  const codeVerifier = sessionStorage.getItem(KEYS.verifier);
  const receivedState = params.get('state');
  // Clear sensitive authorization code out of address bar/history promptly.
  history.replaceState(null, '', redirectUri);
  sessionStorage.removeItem(KEYS.state);
  sessionStorage.removeItem(KEYS.verifier);
  if (!receivedState || !expectedState || receivedState !== expectedState || !codeVerifier) {
    throw new Error('OAuth state/PKCE не совпал. Повтори подключение в том же источнике OBS.');
  }
  if (params.has('error')) throw new Error(`Spotify отказал в доступе: ${params.get('error')}`);
  if (!clientId) throw new Error('Client ID отсутствует после Spotify OAuth. Повтори подключение.');
  const answer = await requestToken({
    grant_type: 'authorization_code', code: params.get('code'),
    redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier,
  });
  saveTokens(answer);
  return true;
}
async function refreshAccessToken() {
  if (!tokens?.refresh_token) throw new Error('Нет refresh token; нужно подключить Spotify заново.');
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const answer = await requestToken({
        grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
        client_id: clientId,
      });
      saveTokens(answer); // supports rotating refresh tokens
      return tokens.access_token;
    } catch (error) {
      if (error.code === 'invalid_grant' || error.code === 'invalid_client') discardTokens();
      throw error;
    } finally { refreshPromise = null; }
  })();
  return refreshPromise;
}
async function accessToken(forceRefresh = false) {
  if (!clientId) throw new Error('Client ID не задан.');
  if (!forceRefresh && tokens?.access_token && tokens.expires_at - Date.now() > 90000) {
    return tokens.access_token;
  }
  return refreshAccessToken();
}
async function fetchCurrentlyPlaying() {
  let token = await accessToken();
  let result = await fetch(API_CURRENT, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (result.status === 401) {
    token = await accessToken(true);
    result = await fetch(API_CURRENT, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  }
  return result;
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
    if (error instanceof FatalError || !tokens) {
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
  if (!tokens?.refresh_token || !clientId) {
    showStatus('Сначала авторизуй Spotify в этом браузере.');
    return;
  }
  els.transferInput.value = JSON.stringify({ version: 1, client_id: clientId, refresh_token: tokens.refresh_token });
  els.transferInput.focus();
  els.transferInput.select();
  showStatus('Скопируй содержимое поля вручную (Ctrl+C), вставь в источник OBS и нажми «Импортировать». Не передавай никому.');
}
function importConnection() {
  try {
    const bundle = JSON.parse(els.transferInput.value);
    if (bundle.version !== 1 || !/^[a-zA-Z0-9]{16,64}$/.test(bundle.client_id) ||
        typeof bundle.refresh_token !== 'string' || bundle.refresh_token.length < 20 || bundle.refresh_token.length > 4096) {
      throw new Error('Недопустимые данные импорта.');
    }
    // Transfer only refresh token; a fresh access token is obtained for the OBS instance.
    clientId = bundle.client_id;
    localStorage.setItem(KEYS.clientId, clientId);
    tokens = { access_token: '', refresh_token: bundle.refresh_token, expires_at: 0 };
    localStorage.setItem(KEYS.tokens, JSON.stringify(tokens));
    els.transferInput.value = '';
    els.clientInput.value = clientId;
    showStatus('Данные импортированы. Проверяем доступ к Spotify...');
    if (!active) { active = true; poll(); }
  } catch (error) { showStatus(`Ошибка импорта: ${error.message}`); }
}
function disconnect() {
  active = false;
  if (pollTimer) clearTimeout(pollTimer);
  clearVisibilityTimer();
  discardTokens();
  sessionStorage.removeItem(KEYS.state);
  sessionStorage.removeItem(KEYS.verifier);
  hideTrack();
  showStatus('Авторизация сброшена. Для повторного подключения нажми кнопку выше.');
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
  for (const img of [els.art, els.artBack, els.bg, els.bgBack]) {
    img.addEventListener('error', () => {
      const placeholder = new URL('./images/placeholder.svg', location.href).href;
      if (img.src !== placeholder) {
        console.warn('Spotify artwork image could not be loaded:', img.src);
        img.src = placeholder;
      }
    });
  }

  if (params.get('demo') === '1') {
    renderPlaying({ is_playing: true, progress_ms: 29000, currently_playing_type: 'track', item: {
      uri: 'spotify:track:demo', type: 'track', name: 'планета', duration_ms: 201000,
      artists: [{ name: 'Амора' }], album: { images: [] },
    }});
    hideStatus();
    return;
  }
  if (!window.isSecureContext) {
    showStatus('Для OAuth необходим HTTPS. Файлы надо разместить на GitHub Pages или другом HTTPS-хостинге.');
    return;
  }
  try { await processOAuthCallback(); }
  catch (e) { showStatus(`Ошибка подключения: ${e.message}`); return; }
  if (!clientId || !tokens?.refresh_token) {
    showStatus('Вставь Client ID и подключи Spotify. Секретный ключ не нужен.');
    return;
  }
  if (debug) showStatus('Режим настроек. Для скрытия этой панели удали ?settings=1 из URL.');
  active = true;
  poll();
}
start().catch(error => showStatus(error.message));
