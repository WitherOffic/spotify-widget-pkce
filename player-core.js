/*
 * Wither Spotify Widget — pure playback helpers.
 * Modified 2026-11-17. GNU GPL version 3; see LICENSE.
 */
export const DEFAULT_POLL_MS = 3000;
export const MIN_POLL_MS = 2000;
export const MAX_POLL_MS = 60000;

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
export function parsePollMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? clamp(Math.round(numeric), MIN_POLL_MS, MAX_POLL_MS)
    : DEFAULT_POLL_MS;
}
export function formatTime(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function retryAfterMs(header, now = Date.now()) {
  if (!header) return null;
  const str = String(header).trim();
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    return Math.max(0, Math.ceil(Number(str) * 1000));
  }
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}
export function normalizeTrack(payload) {
  if (!payload || payload.is_playing !== true || !payload.item || payload.currently_playing_type === 'ad') return null;
  const item = payload.item;
  if (item.type && item.type !== 'track' && item.type !== 'episode') return null;
  const title = typeof item.name === 'string' ? item.name : 'Неизвестный трек';
  const artists = Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean) : [];
  const artist = artists.join(', ') || (item.show?.name ?? 'Spotify');
  const image = item.album?.images?.[0]?.url || item.images?.[0]?.url || item.show?.images?.[0]?.url || null;
  const durationMs = Math.max(0, Number(item.duration_ms) || 0);
  const progressMs = clamp(Number(payload.progress_ms) || 0, 0, durationMs || 0);
  return {
    id: item.uri || item.id || `${title}\0${artist}`,
    title, artist, image,
    durationMs, progressMs,
  };
}
export function progressAt(track, elapsedMs) {
  if (!track) return 0;
  return clamp(track.progressMs + Math.max(0, elapsedMs), 0, track.durationMs);
}
export function getOAuthErrorMessage(responseStatus, body = '') {
  if (responseStatus === 403) return 'Spotify отклонил доступ (403). Проверь Premium владельца приложения, список пользователей в Spotify Developer Dashboard и режим доступа приложения. Это ограничение сервера Spotify, а не ошибка оформления.';
  if (responseStatus === 401) return 'Spotify не принял авторизацию (401). Повтори подключение.';
  return `Spotify API: ошибка ${responseStatus}${body ? ` — ${String(body).slice(0, 180)}` : ''}`;
}
