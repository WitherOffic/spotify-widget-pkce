/*
 * Wither Spotify Widget — resilient album artwork controller.
 * Modified 2026-11-17. GNU GPL version 3; see LICENSE.
 */
const COVER_RETRY_MS = 60000;
const MAX_CACHE = 80;
const isHttpsImage = value => typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value);

export function firstImageUrl(item, excluded = new Set()) {
  for (const images of [item?.album?.images, item?.images, item?.show?.images]) {
    if (!Array.isArray(images)) continue;
    const match = images.find(image => isHttpsImage(image?.url) && !excluded.has(image.url));
    if (match) return match.url;
  }
  return null;
}
export function spotifyItemId(item) {
  const id = item?.id || (typeof item?.uri === 'string' ? item.uri.split(':')[2] : '');
  return /^[a-zA-Z0-9]{22}$/.test(id || '') ? id : null;
}
export function createArtworkController({
  container, images, request, isRateLimited, noteRateLimit, fetchPublic = fetch,
}) {
  let trackId = null;
  let trackItem = null;
  let activeUrl = null;
  let seq = 0;
  let pending = null;
  const bad = new Set();
  const cache = new Map();

  function clear() {
    seq++;
    pending = null;
    trackId = null;
    trackItem = null;
    activeUrl = null;
    container.classList.remove('has-artwork');
    for (const image of images) image.removeAttribute('src');
  }
  function resetForTrack(id,item) {
    if (trackId === id) return;
    clear();
    trackId = id;
    trackItem = item;
  }
  function preload(url) {
    return new Promise(resolve => {
      const img = new Image();
      const timeout = setTimeout(() => {
        img.onload = null;
        img.onerror = null;
        resolve(false);
      }, 8000);
      img.onload = () => { clearTimeout(timeout); resolve(true); };
      img.onerror = () => { clearTimeout(timeout); resolve(false); };
      img.src = url;
    });
  }
  async function useUrl(id,url,attempt) {
    if (!isHttpsImage(url) || bad.has(url)) return false;
    if (activeUrl === url && trackId === id) return true;
    const loaded = await preload(url);
    if (attempt !== seq || trackId !== id) return false;
    if (!loaded) {
      bad.add(url);
      return false;
    }
    activeUrl = url;
    for (const img of images) img.src = url;
    container.classList.add('has-artwork');
    return true;
  }
  async function catalog(type,id) {
    if (!id || isRateLimited()) return null;
    try {
      const response = await request(`https://api.spotify.com/v1/${type}/${id}`);
      if (response.status === 429) {
        noteRateLimit(response);
        return null;
      }
      if (!response.ok) {
        console.info(`Spotify image lookup ${type}: HTTP ${response.status}`);
        return null;
      }
      return await response.json();
    } catch (error) {
      console.info('Artwork catalog request failed:', error.message);
      return null;
    }
  }
  async function oembed(item) {
    const id = spotifyItemId(item);
    if (!id) return null;
    const kind = item?.type === 'episode' ? 'episode' : 'track';
    const url = new URL('https://open.spotify.com/oembed');
    url.searchParams.set('url', `https://open.spotify.com/${kind}/${id}`);
    try {
      const response = await fetchPublic(url, {cache:'force-cache'});
      if (!response.ok) return null;
      const data = await response.json();
      return isHttpsImage(data?.thumbnail_url) ? data.thumbnail_url : null;
    } catch {
      // Browsers may block the public endpoint by CORS; catalog fallback remains.
      return null;
    }
  }
  async function fallback(id,item,attempt) {
    if (item?.is_local || isRateLimited()) return false;
    const saved = cache.get(id);
    if (saved && Date.now()-saved.checkedAt < COVER_RETRY_MS) {
      if (saved.url) return useUrl(id,saved.url,attempt);
      return false;
    }
    const possible = [];
    const publicImage = await oembed(item);
    if (publicImage) possible.push(publicImage);
    const album = await catalog('albums',spotifyItemId(item?.album));
    const fromAlbum = firstImageUrl(album,bad);
    if (fromAlbum) possible.push(fromAlbum);
    const type = item?.type === 'episode' ? 'episodes' : 'tracks';
    const fullTrack = await catalog(type,spotifyItemId(item));
    const fromTrack = firstImageUrl(fullTrack,bad);
    if (fromTrack) possible.push(fromTrack);
    for (const url of new Set(possible)) {
      if (await useUrl(id,url,attempt)) {
        cache.set(id,{url,checkedAt:Date.now()});
        trim();
        return true;
      }
      if (trackId !== id || seq !== attempt) return false;
    }
    cache.set(id,{url:null,checkedAt:Date.now()});
    trim();
    return false;
  }
  function trim() {
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  async function display(id,item,preferredUrl) {
    if (!id) return;
    resetForTrack(id,item);
    trackItem = item;
    if (activeUrl || pending?.id === id) return;
    const attempt = seq;
    const job = (async () => {
      const preferred = isHttpsImage(preferredUrl) ? preferredUrl : firstImageUrl(item,bad);
      if (preferred && await useUrl(id,preferred,attempt)) return;
      if (trackId === id && seq === attempt) await fallback(id,item,attempt);
    })();
    pending = {id,promise:job};
    try { await job; }
    catch(error) { console.info('Artwork load failed:',error.message); }
    finally { if (pending?.promise === job) pending = null; }
  }
  for (const img of images) img.addEventListener('error', () => {
    if (!activeUrl) return;
    bad.add(activeUrl);
    const id=trackId, item=trackItem;
    clear();
    if (id && item) void display(id,item,null);
  });
  return {display,clear};
}
