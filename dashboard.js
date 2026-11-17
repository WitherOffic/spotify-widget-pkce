/*
 * Wither Spotify Widget setup page.
 * A user sees and copies exactly one OBS overlay URL. OAuth credentials
 * remain encrypted in the Worker database, never in the browser source URL.
 */
const SETTINGS_KEY="wither-spotify-dashboard-settings";
const ACCOUNT_KEY="wither-spotify-overlay-connection";
const byId=id=>document.getElementById(id);
const workerInput=byId("workerUrl");
const pairingInput=byId("pairingKey");
const connectionArea=byId("connected");
const linkInput=byId("overlayLink");
const setupStatus=byId("setupStatus");
const linkStatus=byId("linkStatus");
const options={
  poll:byId("poll"),
  duration:byId("duration"),
  showCover:byId("showCover"),
  animateText:byId("animateText"),
};
function load(key) {
  try {return JSON.parse(localStorage.getItem(key)||"null");}catch{return null;}
}
function save(key,value){localStorage.setItem(key,JSON.stringify(value))}
function notice(element,message,error=false) {
  element.textContent=message;
  element.classList.toggle("error",error);
  element.hidden=!message;
}
function getWorkerOrigin() {
  const input=workerInput.value.trim();
  const url=new URL(input);
  if(url.protocol!=="https:" || url.username || url.password || url.pathname!=="/" || url.search || url.hash) {
    throw Error("Укажи адрес HTTPS без пути и параметров, например https://имя.workers.dev");
  }
  return url.origin;
}
function validConnection(connection){
  return connection && typeof connection.id==="string" &&
    typeof connection.viewKey==="string" && typeof connection.ownerKey==="string" &&
    typeof connection.worker==="string";
}
let connection=load(ACCOUNT_KEY);
const previousSettings=load(SETTINGS_KEY)||{};
workerInput.value=connection?.worker||previousSettings.worker||"";
options.poll.value=previousSettings.poll||"3000";
options.duration.value=previousSettings.duration||"0";
options.showCover.checked=previousSettings.showCover!==false;
options.animateText.checked=previousSettings.animateText!==false;

function saveSettings(){
  save(SETTINGS_KEY,{
    worker:workerInput.value.trim(),
    poll:options.poll.value,
    duration:options.duration.value,
    showCover:options.showCover.checked,
    animateText:options.animateText.checked,
  });
}
function overlayURL(){
  if(!validConnection(connection))return "";
  const link=new URL("./overlay.html",location.href);
  link.searchParams.set("api",connection.worker);
  link.searchParams.set("id",connection.id);
  link.searchParams.set("key",connection.viewKey);
  link.searchParams.set("poll",options.poll.value);
  if(options.duration.value!=="0")link.searchParams.set("duration",options.duration.value);
  if(!options.showCover.checked)link.searchParams.set("hideAlbumArt","");
  if(!options.animateText.checked)link.searchParams.set("noAnimation","");
  return link.toString();
}
function paint(){
  connectionArea.hidden=!validConnection(connection);
  if(validConnection(connection))linkInput.value=overlayURL();
}
async function post(api,path,payload) {
  const response=await fetch(api+path,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload),
    cache:"no-store",referrerPolicy:"no-referrer",
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw Error(data.message||data.error||("HTTP "+response.status));
  return data;
}
async function checkWorker(){
  const worker=getWorkerOrigin();
  saveSettings();
  const response=await fetch(worker+"/api/health",{cache:"no-store"});
  const state=await response.json();
  if(!response.ok||!state.ready)throw Error("Worker найден, но база или секреты ещё не настроены.");
  notice(setupStatus,"Worker работает и готов к подключению Spotify.");
}
async function connectSpotify(){
  const worker=getWorkerOrigin();
  const pairingKey=pairingInput.value.trim();
  if(pairingKey.length<24)throw Error("Введи свой секрет PAIRING_KEY из Cloudflare (не Spotify Client Secret).");
  saveSettings();
  const data=await post(worker,"/oauth/start",{pairingKey});
  if(!data.authorizeUrl || !/^https:\/\/accounts\.spotify\.com\/authorize/.test(data.authorizeUrl)){
    throw Error("Worker вернул некорректный адрес Spotify.");
  }
  pairingInput.value="";
  location.assign(data.authorizeUrl);
}
function consumeOAuthReturn(){
  const fragment=new URLSearchParams(location.hash.slice(1));
  const linked=fragment.get("linked"),view=fragment.get("view"),owner=fragment.get("owner"),api=fragment.get("api");
  const error=fragment.get("error");
  if(!linked&&!error)return;
  // Remove all connection keys from address bar/history as early as possible.
  history.replaceState(null,"",location.pathname+location.search);
  if(error) {
    notice(setupStatus,"Spotify не подключён: "+error,true);
    return;
  }
  try {
    const u=new URL(api);
    if(u.protocol!=="https:")throw Error("Некорректный адрес API");
    if(!/^[a-zA-Z0-9_-]{16,48}$/.test(linked)||view?.length<40||owner?.length<40) {
      throw Error("Worker вернул неполный набор ключей.");
    }
    connection={id:linked,viewKey:view,ownerKey:owner,worker:u.origin};
    workerInput.value=u.origin;
    save(ACCOUNT_KEY,connection);
    saveSettings();
    notice(linkStatus,"Spotify подключён. Ссылка для OBS готова.");
  }catch(err){
    notice(setupStatus,"Не удалось получить ссылку: "+err.message,true);
  }
}
async function checkConnection(){
  if(!validConnection(connection))return;
  try {
    const response=await post(connection.worker,"/api/owner",{
      id:connection.id,ownerKey:connection.ownerKey,
    });
    if(response.connected)notice(linkStatus,"Подключение подтверждено. Скопируй ссылку в OBS.");
  }catch(e){
    notice(linkStatus,"Подключение не подтверждено: "+e.message,true);
  }
}
async function copyLink(){
  const link=overlayURL();
  if(!link)return;
  try {
    await navigator.clipboard.writeText(link);
  }catch{
    linkInput.focus();
    linkInput.select();
    if(!document.execCommand("copy"))throw Error("Скопируй текст ссылки вручную.");
  }
  notice(linkStatus,"Ссылка скопирована. Добавь её в OBS как источник «Браузер».");
}
async function rotateLink(){
  if(!validConnection(connection))return;
  if(!confirm("Старая ссылка в OBS перестанет работать. Продолжить?"))return;
  const result=await post(connection.worker,"/api/rotate",{
    id:connection.id,ownerKey:connection.ownerKey,
  });
  connection.viewKey=result.viewKey;
  save(ACCOUNT_KEY,connection);
  paint();
  notice(linkStatus,"Новая ссылка готова. Обязательно замени URL в OBS.");
}
async function disconnect(){
  if(!validConnection(connection))return;
  if(!confirm("Удалить Spotify-подключение на сервере? Ссылка OBS перестанет работать."))return;
  await post(connection.worker,"/api/revoke",{
    id:connection.id,ownerKey:connection.ownerKey,
  });
  connection=null;
  localStorage.removeItem(ACCOUNT_KEY);
  paint();
  notice(setupStatus,"Подключение удалено. Можно авторизоваться повторно.");
}
function withStatus(handler,element){
  return async()=>{
    try{await handler()}catch(e){notice(element,e.message,true)}
  };
}
byId("checkWorker").addEventListener("click",withStatus(checkWorker,setupStatus));
byId("connectSpotify").addEventListener("click",withStatus(connectSpotify,setupStatus));
byId("copyLink").addEventListener("click",withStatus(copyLink,linkStatus));
byId("previewLink").addEventListener("click",()=>{
  const link=overlayURL();
  if(link)window.open(link,"_blank","noopener,noreferrer");
});
byId("rotateLink").addEventListener("click",withStatus(rotateLink,linkStatus));
byId("disconnect").addEventListener("click",withStatus(disconnect,linkStatus));
for(const element of Object.values(options)){
  element.addEventListener("change",()=>{saveSettings();paint()});
}
consumeOAuthReturn();
paint();
void checkConnection();
