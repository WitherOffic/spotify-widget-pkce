/*
 * Public Spotify oEmbed thumbnail lookup for OBS browsers.
 * Never needs Spotify user tokens or secret values.
 */
const ID = /^[A-Za-z0-9]{22}$/;
export function publicSpotifyId(song) {
  const uri=String(song?.id||"");
  const match=uri.match(/^spotify:(track|episode):([A-Za-z0-9]{22})$/);
  if(match)return {kind:match[1],id:match[2]};
  try {
    const url=new URL(song?.spotifyUrl||"");
    if(url.hostname!=="open.spotify.com" || url.protocol!=="https:")return null;
    const parts=url.pathname.split("/").filter(Boolean);
    if(parts.length===2 && (parts[0]==="track"||parts[0]==="episode") && ID.test(parts[1])) {
      return {kind:parts[0],id:parts[1]};
    }
  }catch {}
  return null;
}
const cache=new Map();
export async function publicThumbnail(song, fetchFn=fetch, now=Date.now) {
  const entity=publicSpotifyId(song);
  if(!entity)return null;
  const key=entity.kind+"/"+entity.id;
  const entry=cache.get(key);
  if(entry && now()-entry.time < (entry.url?86_400_000:60_000))return entry.url;
  const endpoint=new URL("https://open.spotify.com/oembed");
  endpoint.searchParams.set("url","https://open.spotify.com/"+key);
  let art=null;
  try {
    const response=await fetchFn(endpoint.toString(),{cache:"no-store",signal:AbortSignal.timeout(5000)});
    if(response.ok) {
      const data=await response.json();
      if(/^https:\/\/[^\s]+$/i.test(data.thumbnail_url||""))art=data.thumbnail_url;
    }
  }catch {}
  cache.set(key,{url:art,time:now()});
  if(cache.size>80)cache.delete(cache.keys().next().value);
  return art;
}
