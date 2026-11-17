/*
 * Wither Spotify Widget — single-page setup for streamer and invited friends.
 * Existing browser storage and OBS URL format remain compatible.
 * Refresh tokens never enter the page or browser-source URL.
 */
const SETTINGS_KEY="wither-spotify-dashboard-settings";
const ACCOUNT_KEY="wither-spotify-overlay-connection";
const ADMIN_KEY="wither-spotify-admin-session";
const byId=id=>document.getElementById(id);
const workerInput=byId("workerUrl");
const pairingInput=byId("pairingKey");
const setupArea=byId("setup");
const connectionArea=byId("connected");
const friendsArea=byId("friendsCard");
const adminAccessArea=byId("adminAccessArea");
const adminStatus=byId("adminStatus");
const accountArea=byId("accountCard");
const linkInput=byId("overlayLink");
const setupStatus=byId("setupStatus");
const linkStatus=byId("linkStatus");
const inviteStatus=byId("inviteStatus");
const badge=byId("connectionBadge");
const options={
  poll:byId("poll"),
  duration:byId("duration"),
  showCover:byId("showCover"),
  animateText:byId("animateText"),
};
function load(key){
  try{return JSON.parse(localStorage.getItem(key)||"null")}catch{return null}
}
function save(key,value){localStorage.setItem(key,JSON.stringify(value))}
function notice(element,message,error=false){
  element.textContent=message;
  element.classList.toggle("error",error);
  element.hidden=!message;
}
function setBadge(message,state=""){
  badge.textContent=message;
  badge.classList.toggle("good",state==="good");
  badge.classList.toggle("bad",state==="bad");
}
function getWorkerOrigin(){
  const url=new URL(workerInput.value.trim());
  if(url.protocol!=="https:" || url.username || url.password || url.pathname!=="/" || url.search || url.hash){
    throw Error("Вставь только HTTPS-адрес Cloudflare Worker, без пути и параметров.");
  }
  return url.origin;
}
function validConnection(c){
  return c && typeof c.id==="string" && typeof c.viewKey==="string" &&
    typeof c.ownerKey==="string" && typeof c.worker==="string";
}
let connection=load(ACCOUNT_KEY);
let activeInvite=null;
let generatedInvite="";
let adminSession=load(ADMIN_KEY);
let adminVerified=false;
let checkingAdmin=Boolean(adminSession?.token);
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
  const connected=Boolean(validConnection(connection));
  const authorized=connected && adminVerified &&
    adminSession?.worker===connection.worker;
  connectionArea.hidden=!connected;
  friendsArea.hidden=!authorized;
  adminAccessArea.hidden=!connected || authorized || checkingAdmin;
  accountArea.hidden=!connected;
  setupArea.hidden=connected && !activeInvite;
  if(connected) linkInput.value=overlayURL();
  else linkInput.value="";
}
async function post(api,path,payload){
  const response=await fetch(api+path,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload),
    cache:"no-store",
    referrerPolicy:"no-referrer",
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error(data.message||data.error||("HTTP "+response.status));
    error.status=response.status;
    throw error;
  }
  return data;
}
async function checkWorker(){
  const worker=getWorkerOrigin();
  saveSettings();
  const response=await fetch(worker+"/api/health",{cache:"no-store"});
  const state=await response.json().catch(()=>({}));
  if(!response.ok || !state.ready)throw Error("Worker найден, но база или секреты не готовы.");
  notice(setupStatus,"Cloudflare Worker доступен. Можно подключить Spotify.");
}
async function connectSpotify(){
  const worker=getWorkerOrigin();
  const secret=pairingInput.value.trim();
  if(!activeInvite && secret.length<24)throw Error("Введи PAIRING_KEY или открой приглашение от владельца.");
  saveSettings();
  const data=await post(worker,"/oauth/start",
    activeInvite ? {invite:activeInvite} : {pairingKey:secret});
  if(!data.authorizeUrl || !/^https:\/\/accounts\.spotify\.com\/authorize/.test(data.authorizeUrl)) {
    throw Error("Worker вернул некорректную ссылку Spotify.");
  }
  pairingInput.value="";
  activeInvite=null;
  location.assign(data.authorizeUrl);
}
function consumeOAuthReturn(){
  const fragment=new URLSearchParams(location.hash.slice(1));
  const linked=fragment.get("linked"),view=fragment.get("view"),owner=fragment.get("owner"),api=fragment.get("api");
  const error=fragment.get("error");
  if(!linked && !error)return;
  // Clear owner and viewer keys from the address bar/history before showing UI.
  history.replaceState(null,"",location.pathname+location.search);
  if(error){
    notice(setupStatus,"Spotify не подключён: "+error,true);
    return;
  }
  try{
    const worker=new URL(api);
    if(worker.protocol!=="https:")throw Error("Некорректный адрес API");
    if(!/^[a-zA-Z0-9_-]{16,48}$/.test(linked) || view?.length<40 || owner?.length<40) {
      throw Error("Worker вернул неполное подключение.");
    }
    connection={id:linked,viewKey:view,ownerKey:owner,worker:worker.origin};
    workerInput.value=worker.origin;
    save(ACCOUNT_KEY,connection);
    saveSettings();
    notice(linkStatus,"Spotify подключён. Скопируй персональную ссылку в OBS.");
  }catch(err){notice(setupStatus,"Не удалось получить ссылку: "+err.message,true);}
}
function consumeFriendInvite(){
  const fragment=new URLSearchParams(location.hash.slice(1));
  const invite=fragment.get("invite");
  if(!invite)return;
  history.replaceState(null,"",location.pathname+location.search);
  try{
    const api=new URL(fragment.get("api")||"");
    if(api.protocol!=="https:" || !/^[a-zA-Z0-9_-]{32}$/.test(invite)) {
      throw Error("Неправильная или повреждённая ссылка.");
    }
    activeInvite=invite;
    workerInput.value=api.origin;
    workerInput.readOnly=true;
    byId("pairingArea").hidden=true;
    byId("friendWelcome").hidden=false;
    byId("setupTitle").textContent="Подключить свой Spotify";
    byId("setupTag").textContent="По приглашению";
    byId("setupIntro").textContent="Твоё подключение будет отдельным от аккаунта владельца. Для OBS получишь свою персональную ссылку.";
    saveSettings();
  }catch(error){notice(setupStatus,error.message,true);}
}
async function checkConnection(){
  if(!validConnection(connection))return;
  setBadge("Проверка подключения");
  try{
    const response=await post(connection.worker,"/api/owner",{
      id:connection.id,ownerKey:connection.ownerKey,
    });
    if(response.connected)setBadge("Spotify подключён","good");
  }catch(e){
    setBadge("Не удалось проверить","bad");
    notice(linkStatus,"Подключение не подтверждено: "+e.message,true);
  }
}
async function copy(text,input){
  if(!text)throw Error("Сначала подключи Spotify.");
  try{
    await navigator.clipboard.writeText(text);
  }catch{
    const prevType=input.type;
    input.type="text";
    input.focus();input.select();
    const ok=document.execCommand("copy");
    input.type=prevType;
    if(!ok)throw Error("Не удалось скопировать. Выдели ссылку вручную.");
  }
}
async function copyLink(){
  await copy(overlayURL(),linkInput);
  notice(linkStatus,"Ссылка скопирована. В OBS используй источник «Браузер», 550 × 160.");
}
function clearAdminSession(){
  adminSession=null;
  adminVerified=false;
  localStorage.removeItem(ADMIN_KEY);
  paint();
}
function showAdminExpiry(expiresAt){
  const date=new Date(expiresAt);
  byId("adminExpiry").textContent=Number.isFinite(date.getTime())
    ? "Режим владельца действует до "+date.toLocaleDateString("ru-RU")+
      ". Только приглашения; Spotify и настройки Worker изменить нельзя."
    : "Административный доступ активен только для создания приглашений.";
}
async function activateAdmin(){
  if(!validConnection(connection))throw Error("Сначала подключи свой Spotify.");
  const field=byId("adminLoginKey");
  const key=field.value.trim();
  if(key.length<24)throw Error("Нужен PAIRING_KEY из Cloudflare.");
  try{
    const value=await post(connection.worker,"/api/admin/activate",{pairingKey:key});
    if(!/^[A-Za-z0-9_-]{43}$/.test(value.adminSession||"") ||
      !Number.isFinite(Number(value.expiresAt))){
      throw Error("Worker вернул недействительный ключ владельца.");
    }
    // The pairing key is never saved. Only a scoped, revocable credential
    // restricted to invitation creation persists in this browser.
    adminSession={worker:connection.worker,token:value.adminSession,expiresAt:value.expiresAt};
    save(ADMIN_KEY,adminSession);
    adminVerified=true;
    checkingAdmin=false;
    showAdminExpiry(value.expiresAt);
    paint();
    notice(inviteStatus,"Режим владельца активирован. Приглашения можно создавать без PAIRING_KEY.");
  }finally{
    field.value="";
  }
}
async function checkAdmin(){
  if(!adminSession?.token || !validConnection(connection) ||
    adminSession.worker!==connection.worker){
    checkingAdmin=false;
    adminVerified=false;
    paint();
    return;
  }
  checkingAdmin=true;
  paint();
  try{
    const result=await post(connection.worker,"/api/admin/status",{
      adminSession:adminSession.token,
    });
    if(result.active!==true)throw Error("Сеанс владельца недействителен.");
    adminVerified=true;
    showAdminExpiry(result.expiresAt);
  }catch(error){
    adminVerified=false;
    if(error.status===403){
      clearAdminSession();
      notice(adminStatus,"Срок действия режима владельца истёк. Подтверди права ещё раз.");
    }else{
      notice(adminStatus,"Не удалось проверить права владельца: "+error.message,true);
    }
  }finally{
    checkingAdmin=false;
    paint();
  }
}
async function revokeAdmin(){
  if(!adminVerified || !adminSession?.token)return;
  if(!confirm("Отозвать управление приглашениями для этого браузера? OBS-ссылка продолжит работать."))return;
  await post(adminSession.worker,"/api/admin/revoke",{adminSession:adminSession.token});
  clearAdminSession();
  notice(adminStatus,"Административный доступ отозван. Spotify и OBS продолжают работать.");
}
async function createInvite(){
  if(!validConnection(connection) || !adminVerified || !adminSession?.token ||
    adminSession.worker!==connection.worker)throw Error("Сначала включи права владельца.");
  let result;
  try{
    result=await post(connection.worker,"/api/invite/create",{
      adminSession:adminSession.token,
    });
  }catch(error){
    if(error.status===403){
      clearAdminSession();
      notice(adminStatus,"Доступ владельца закончился. Включи его повторно.",true);
    }
    throw error;
  }
  if(!/^[a-zA-Z0-9_-]{32}$/.test(result.inviteCode||""))throw Error("Worker вернул некорректный код.");
  const url=new URL("./index.html",location.href);
  url.search="";
  url.hash=new URLSearchParams({api:connection.worker,invite:result.inviteCode}).toString();
  generatedInvite=url.toString();
  byId("inviteLink").value=generatedInvite;
  byId("inviteResult").hidden=false;
  notice(inviteStatus,"Приглашение создано. Действует 48 часов и может быть использовано один раз.");
}
async function copyInvite(){
  await copy(generatedInvite,byId("inviteLink"));
  notice(inviteStatus,"Приглашение скопировано. Отправь другу в личном сообщении.");
}
async function rotateLink(){
  if(!validConnection(connection))return;
  if(!confirm("Старая ссылка OBS перестанет работать. Создать новую?"))return;
  const result=await post(connection.worker,"/api/rotate",{id:connection.id,ownerKey:connection.ownerKey});
  connection.viewKey=result.viewKey;
  save(ACCOUNT_KEY,connection);
  linkInput.type="password";
  byId("toggleLink").textContent="Показать";
  paint();
  notice(linkStatus,"Новая ссылка готова. Замени старый URL в OBS.");
}
async function disconnect(){
  if(!validConnection(connection))return;
  if(!confirm("Удалить Spotify-подключение на сервере? Ссылка OBS перестанет работать."))return;
  await post(connection.worker,"/api/revoke",{id:connection.id,ownerKey:connection.ownerKey});
  connection=null;
  localStorage.removeItem(ACCOUNT_KEY);
  setBadge("Не подключено","bad");
  paint();
  notice(setupStatus,"Подключение отключено. Можно войти с другим аккаунтом.");
}
function withStatus(handler,element){
  return async event=>{
    const btn=event.currentTarget;
    btn.disabled=true;
    try{await handler()}catch(e){notice(element,e.message,true)}
    finally{btn.disabled=false}
  };
}
byId("checkWorker").addEventListener("click",withStatus(checkWorker,setupStatus));
byId("connectSpotify").addEventListener("click",withStatus(connectSpotify,setupStatus));
byId("copyLink").addEventListener("click",withStatus(copyLink,linkStatus));
byId("previewLink").addEventListener("click",()=>{
  const link=overlayURL();if(link)window.open(link,"_blank","noopener,noreferrer");
});
byId("toggleLink").addEventListener("click",()=>{
  const reveal=linkInput.type==="password";
  linkInput.type=reveal?"text":"password";
  byId("toggleLink").textContent=reveal?"Скрыть":"Показать";
});
byId("enableAdmin").addEventListener("click",withStatus(activateAdmin,adminStatus));
byId("revokeAdmin").addEventListener("click",withStatus(revokeAdmin,inviteStatus));
byId("createInvite").addEventListener("click",withStatus(createInvite,inviteStatus));
byId("copyInvite").addEventListener("click",withStatus(copyInvite,inviteStatus));
byId("rotateLink").addEventListener("click",withStatus(rotateLink,linkStatus));
byId("disconnect").addEventListener("click",withStatus(disconnect,setupStatus));
for(const element of Object.values(options)){
  element.addEventListener("change",()=>{saveSettings();paint();});
}
consumeOAuthReturn();
consumeFriendInvite();
paint();
void checkConnection();
void checkAdmin();
