/*
 * Wither Spotify Widget OBS view.
 * Does not receive/store Spotify tokens. Only the opaque read-only overlay key.
 */
import {progressAt,formatTime,parsePollMs,clamp} from './player-core.js';
import {createTextTransition} from './src/track-animation.js';

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
  els.main.classList.remove("has-artwork");
  for(const img of imgs) img.removeAttribute("src");
}
async function image(url,trackId){
  clearArtwork();
  if(!/^https:\/\/[^\s]+$/i.test(url||"")) return;
  const id=artworkGeneration;
  const preload=new Image();
  const ok=await new Promise(resolve=>{
    const t=setTimeout(()=>resolve(false),7000);
    preload.onload=()=>{clearTimeout(t);resolve(true)};
    preload.onerror=()=>{clearTimeout(t);resolve(false)};
    preload.src=url;
  });
  if(!ok || id!==artworkGeneration || activeTrack?.id!==trackId) return;
  for(const element of imgs) element.src=url;
  els.main.classList.add("has-artwork");
}
for(const el of imgs) el.addEventListener("error",()=>clearArtwork());
function tick(){
  if(!activeTrack)return;
  const position=progressAt(activeTrack,performance.now()-sampledAt);
  els.elapsed.textContent=formatTime(position);
  els.remaining.textContent="-"+formatTime(activeTrack.durationMs-position);
  els.progress.style.width=(activeTrack.durationMs>0?position/activeTrack.durationMs*100:0)+"%";
}
function render(song){
  if(!song?.playing){
    activeTrack=null;
    previousId=null;
    textEffect.cancel();
    clearArtwork();
    clearTimeout(hideTimer);
    show(false);
    return;
  }
  const changed=song.id!==previousId;
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
    void image(song.image,song.id);
  } else if(song.image && !els.main.classList.contains("has-artwork")) {
    void image(song.image,song.id);
  }
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
