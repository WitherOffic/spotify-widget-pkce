/*
 * Wither Spotify Widget OBS view.
 * Does not receive/store Spotify tokens. Only the opaque read-only overlay key.
 */
import {progressAt,formatTime,parsePollMs,clamp} from './player-core.js';
import {createTextTransition} from './src/track-animation.js';
import {publicThumbnail} from './src/public-artwork.js';
import {preferPublicCover} from './src/cover-priority.js';

const params=new URLSearchParams(location.search);
const els={
  main:document.getElementById("mainContainer"),
  song:document.getElementById("songLabel"),
  artist:document.getElementById("artistLabel"),
  elapsed:document.getElementById("progressTime"),
  remaining:document.getElementById("timeRemaining"),
  progress:document.getElementById("progressBar"),
  viewport:document.getElementById("trackTextViewport"),
  cover:document.getElementById("albumArt"),
  coverBack:document.getElementById("albumArtBack"),
  bg:document.getElementById("backgroundImage"),
  bgBack:document.getElementById("backgroundImageBack"),
  source:document.getElementById("spotifyAttribution"),
  status:document.getElementById("overlayStatus"),
};
const pollMs=parsePollMs(params.get("poll"));
const duration=clamp(Number(params.get("duration"))||0,0,3600)*1000;
const noAnimation=params.has("noAnimation") || matchMedia("(prefers-reduced-motion: reduce)").matches;
const textEffect=createTextTransition(els.viewport,els.song,els.artist,{enabled:!noAnimation});
const overlayId=params.get("id")||"";
const viewKey=params.get("key")||"";
let apiOrigin="";
try {
  const supplied=new URL(params.get("api")||"");
  if(supplied.protocol!=="https:") throw Error("HTTPS required");
  apiOrigin=supplied.origin;
} catch {}
let activeTrack=null;
let previousId=null;
let sampledAt=performance.now();
let artworkGeneration=0;
let coverTask=null;
let coverRetryAfter=0;
let latestSong=null;
const brokenCoverUrls=new Set();
let visible=false;
let hideTimer=null;
let consecutiveErrors=0;
const imgs=[els.cover,els.coverBack,els.bg,els.bgBack];

function status(message) {
  els.status.textContent=message;
  els.status.hidden=false;
  els.main.style.opacity="0";
}
function show(showIt) {
  visible=showIt;
  els.main.style.opacity=showIt?"1":"0";
  els.main.style.bottom=showIt?"50%":"calc(50% - 20px)";
}
function clearArtwork(){
  artworkGeneration++;
  coverTask=null;
  coverRetryAfter=0;
  brokenCoverUrls.clear();
  els.main.classList.remove("has-artwork");
  for(const img of imgs) img.removeAttribute("src");
}
const usableCover=url=>/^https:\/\/[^\s]+$/i.test(url||"");
async function probeCover(url,trackId,generation) {
  if(!usableCover(url) || brokenCoverUrls.has(url))return false;
  const candidate=new Image();
  const loaded=await new Promise(resolve=>{
    const timeout=setTimeout(()=>{
      candidate.onload=null;
      candidate.onerror=null;
      resolve(false);
    },4000);
    candidate.onload=()=>{clearTimeout(timeout);resolve(true)};
    candidate.onerror=()=>{clearTimeout(timeout);resolve(false)};
    candidate.src=url;
  });
  if(generation!==artworkGeneration || activeTrack?.id!==trackId)return false;
  if(!loaded){
    brokenCoverUrls.add(url);
    console.info("Artwork source timed out or could not load.");
  }
  return loaded;
}
async function image(song){
  if(!song?.id || activeTrack?.id!==song.id ||
     els.main.classList.contains("has-artwork") ||
     coverTask?.trackId===song.id || Date.now()<coverRetryAfter)return;
  const generation=artworkGeneration;
  const attempted=new Map();
  // Deduplicate when oEmbed and the Worker supply the same CDN URL.
  const probe=url=>{
    if(!attempted.has(url))attempted.set(url,probeCover(url,song.id,generation));
    return attempted.get(url);
  };
  const task=(async()=>{
    const url=await preferPublicCover({
      lookupPublic:()=>publicThumbnail(song),
      backupUrl:song.image,
      probe,
      graceMs:1000,
    });
    if(generation!==artworkGeneration || activeTrack?.id!==song.id)return;
    if(url){
      for(const element of imgs)element.src=url;
      els.main.classList.add("has-artwork");
      return;
    }
    coverRetryAfter=Date.now()+30_000;
    console.info("No usable Spotify cover; neutral card will be shown.");
  })();
  coverTask={trackId:song.id,promise:task};
  try{await task}finally{
    if(coverTask?.promise===task)coverTask=null;
  }
}
for(const element of imgs)element.src=url;
  els.main.classList.add("has-artwork");
  return true;
}
async function image(song){
  if(!song?.id || activeTrack?.id!==song.id ||
     els.main.classList.contains("has-artwork") ||
     coverTask?.trackId===song.id || Date.now()<coverRetryAfter)return;
  const generation=artworkGeneration;
  const task=(async()=>{
    if(await preloadCover(song.image,song.id,generation))return;
    if(generation!==artworkGeneration || activeTrack?.id!==song.id)return;
    // Public Spotify oEmbed in the browser is a fallback if the Worker was
    // refused by Spotify or the catalog response lacked album.images.
    const fallback=await publicThumbnail(song);
    if(generation!==artworkGeneration || activeTrack?.id!==song.id)return;
    if(await preloadCover(fallback,song.id,generation))return;
    if(generation===artworkGeneration && activeTrack?.id===song.id) {
      coverRetryAfter=Date.now()+60_000;
      console.info("Spotify cover unavailable; neutral card will be shown.");
    }
  })();
  coverTask={trackId:song.id,promise:task};
  try{await task}finally{
    if(coverTask?.promise===task)coverTask=null;
  }
}
for(const element of imgs)element.addEventListener("error",()=>{
  const src=element.getAttribute("src");
  if(!src || !latestSong || activeTrack?.id!==latestSong.id)return;
  clearArtwork();
  brokenCoverUrls.add(src);
  void image(latestSong);
});
function tick(){
  if(!activeTrack)return;
  const position=progressAt(activeTrack,performance.now()-sampledAt);
  els.elapsed.textContent=formatTime(position);
  els.remaining.textContent="-"+formatTime(activeTrack.durationMs-position);
  els.progress.style.width=(activeTrack.durationMs>0?position/activeTrack.durationMs*100:0)+"%";
}
function render(song){
  if(!song?.playing){
    latestSong=null;
    activeTrack=null;
    previousId=null;
    textEffect.cancel();
    clearArtwork();
    clearTimeout(hideTimer);
    show(false);
    return;
  }
  const changed=song.id!==previousId;
  latestSong=song;
  activeTrack={
    id:song.id,
    progressMs:Math.max(0,Number(song.progressMs)||0),
    durationMs:Math.max(0,Number(song.durationMs)||0),
  };
  sampledAt=performance.now();
  if(changed){
    const wasPrevious=Boolean(previousId);
    previousId=song.id;
    textEffect.animate(String(song.title||""),String(song.artist||""),wasPrevious);
    clearArtwork();
  }
  void image(song);
  els.source.href=/^https:\/\/open\.spotify\.com\//.test(song.spotifyUrl||"")
    ?song.spotifyUrl:"https://open.spotify.com/";
  tick();
  // Do not repeatedly reveal a time-limited popup after its duration expires.
  if(changed || (!visible && duration===0)){
    clearTimeout(hideTimer);
    show(true);
    if(duration>0)hideTimer=setTimeout(()=>show(false),duration);
  }
}
async function requestSong(){
  const response=await fetch(apiOrigin+"/api/now",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({id:overlayId,viewKey}),
    cache:"no-store",
    referrerPolicy:"no-referrer",
  });
  if(response.status===202)return null;
  const data=await response.json().catch(()=>({}));
  if(response.status===403){
    throw Error("Ссылка OBS недействительна. Создай новую на главной странице.");
  }
  if(!response.ok)throw Error("Spotify API временно недоступен ("+response.status+").");
  return data;
}
async function run(){
  if(params.get("demo")==="1"){
    const tracks=[
      ["Демонстрационный трек","Тестовый исполнитель"],
      ["Следующая композиция","Другой исполнитель"],
      ["Третья песня","Исполнитель №3"],
    ];
    let index=0;
    const display=()=>{
      const [title,artist]=tracks[index];
      render({playing:true,id:"demo-"+index,title,artist,progressMs:5000,durationMs:190000,image:null});
    };
    display();
    setInterval(()=>{index=(index+1)%tracks.length;display()},6500);
    return;
  }
  if(!apiOrigin || !overlayId || !viewKey) {
    status("Не настроен OBS-оверлей. Открой главную страницу и скопируй готовую ссылку.");
    return;
  }
  async function poll(){
    try{
      const data=await requestSong();
      consecutiveErrors=0;
      if(data && data.playing!==undefined){
        const wasStatusVisible=!els.status.hidden;
        els.status.hidden=true;
        // Repeated stale Spotify data must not rewind the local progress timer.
        if(!(data.stale && activeTrack && data.id===activeTrack.id)) {
          if(wasStatusVisible && activeTrack && duration===0) show(true);
          render(data);
        }
      }
    }catch(error){
      consecutiveErrors++;
      if(!activeTrack || consecutiveErrors>5) {
        status(error.message);
      } else {
        console.warn("Wither Spotify Widget:",error.message);
      }
    }finally{
      setTimeout(poll,pollMs);
    }
  }
  poll();
}
if(params.has("hideAlbumArt")){
  document.getElementById("albumArtBox").style.display="none";
  document.getElementById("songInfoBox").style.width="calc(100% - 20px)";
  els.main.style.maxWidth="400px";
}
function resize(){
  const scale=Math.min(2.2,Math.max(.2,innerWidth/550));
  els.main.style.transform="translate(-50%,50%) scale("+scale+")";
}
addEventListener("resize",resize);
resize();
setInterval(tick,250);
run().catch(e=>status(e.message));
