/*
 * Wither Spotify Widget — Spotify artwork fallbacks.
 * Keep Spotify tokens server-side; never return the Authorization header.
 */
const VALID_ID = /^[A-Za-z0-9]{22}$/;
export const NO_COVER_CACHE_MS = 60_000;
export const COVER_CACHE_MS = 86_400_000;
export const isCoverUrl = value => typeof value === "string" && /^https:\/\/[^\s]+$/i.test(value);
export const spotifyId = entity => {
  const raw = entity?.id || (typeof entity?.uri === "string" ? entity.uri.split(":")[2] : "");
  return VALID_ID.test(raw || "") ? raw : null;
};
export function findCover(entity) {
  for (const images of [entity?.album?.images, entity?.images, entity?.show?.images]) {
    if (!Array.isArray(images)) continue;
    const first = images.find(image => isCoverUrl(image?.url));
    if (first) return first.url;
  }
  return null;
}
export async function resolveArtwork(env, item, tokens, {fetchFn=fetch,clock=Date.now}={}) {
  if (item?.is_local) return null;
  const id = spotifyId(item);
  if (!id) return null;
  const currentTime = clock();
  const cached = await env.DB.prepare("SELECT url,checked_at FROM art_cache WHERE id=?").bind(id).first();
  const ttl = cached?.url ? COVER_CACHE_MS : NO_COVER_CACHE_MS;
  if (cached && currentTime-Number(cached.checked_at)<ttl) return isCoverUrl(cached.url) ? cached.url : null;
  const isEpisode = item?.type === "episode";
  const kind = isEpisode ? "episode" : "track";
  let image = null;
  const fetchJSON = async (url, headers={}) => {
    try {
      const result=await fetchFn(url, {
        headers, signal:AbortSignal.timeout(4500),
      });
      if(!result.ok) return null;
      return await result.json();
    }catch { return null; }
  };
  // Spotify's public oEmbed endpoint officially provides thumbnail_url.
  const embed = new URL("https://open.spotify.com/oembed");
  embed.searchParams.set("url", "https://open.spotify.com/"+kind+"/"+id);
  const embedData=await fetchJSON(embed.toString(), {"Accept":"application/json"});
  if(isCoverUrl(embedData?.thumbnail_url))image=embedData.thumbnail_url;
  // Some hosting providers cannot reach oEmbed, so use supported catalog requests.
  if(!image && tokens?.access_token) {
    const headers={Authorization:"Bearer "+tokens.access_token};
    const catalog = await fetchJSON("https://api.spotify.com/v1/"+(isEpisode?"episodes":"tracks")+"/"+id,headers);
    image=findCover(catalog);
    const albumId=spotifyId(catalog?.album)||spotifyId(item?.album);
    if(!image && albumId) {
      const album=await fetchJSON("https://api.spotify.com/v1/albums/"+albumId,headers);
      image=findCover(album);
    }
  }
  await env.DB.prepare(
    "INSERT INTO art_cache (id,url,checked_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,checked_at=excluded.checked_at"
  ).bind(id,image,clock()).run();
  return image;
}
