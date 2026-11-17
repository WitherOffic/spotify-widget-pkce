import {resolveArtwork} from './artwork.js';
/*
 * Wither Spotify Widget - server-side Spotify connector.
 * Copyright (C) 2026 contributors. GPL-3.0-only; see LICENSE.
 * Runs as Cloudflare Worker with D1. No refresh token is ever sent to OBS.
 */
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const CURRENT_ENDPOINT = "https://api.spotify.com/v1/me/player/currently-playing";
const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const NOW_CACHE_MS = 2800;
const LOCK_MS = 20000;
const ADMIN_SESSION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, invitation creation only
const VALID_ADMIN_SESSION = /^[A-Za-z0-9_-]{43}$/;
const VALID_ID = /^[A-Za-z0-9_-]{16,48}$/;
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const randomUrl = size => base64Url(crypto.getRandomValues(new Uint8Array(size)));
function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode64(value) {
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), c => c.charCodeAt(0));
}
async function sha256(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function aesKey(env) {
  if (!env.TOKEN_ENC_KEY) throw Error("TOKEN_ENC_KEY is not configured");
  const bytes = decode64(env.TOKEN_ENC_KEY);
  if (bytes.length !== 32) throw Error("TOKEN_ENC_KEY must contain 32 random bytes encoded in base64");
  return crypto.subtle.importKey("raw", bytes, {name: "AES-GCM"}, false, ["encrypt", "decrypt"]);
}
async function seal(env, object) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(object));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, await aesKey(env), plain));
  return base64Url(iv) + "." + base64Url(ciphertext);
}
async function unseal(env, cipher) {
  const [iv, data] = cipher.split(".");
  const bytes = await crypto.subtle.decrypt({name:"AES-GCM",iv:decode64(iv)},await aesKey(env),decode64(data));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function originOf(env) {
  return new URL(env.SITE_URL).origin;
}
function cors(env) {
  return {
    ...HEADERS,
    "Access-Control-Allow-Origin": originOf(env),
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(data, status, env, extra={}) {
  return new Response(JSON.stringify(data), {status, headers:{...cors(env), ...extra}});
}
function safeError(error) {
  console.error("Worker error:", error && error.message);
  return {error:"server_error",message:"Ошибка серверного подключения. Проверь Cloudflare Worker."};
}
function siteRedirect(env, fragment) {
  const url = new URL(env.SITE_URL);
  url.hash = fragment;
  return new Response(null, {
    status:302,
    headers:{"Location":url.toString(),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"},
  });
}
function validSite(env) {
  const u=new URL(env.SITE_URL);
  return u.protocol==="https:" && !u.username && !u.password;
}
async function bodyJson(req) {
  if ((Number(req.headers.get("Content-Length"))||0)>4096) throw Error("Request too large");
  return req.json().catch(()=>({}));
}
function tokensValid(data) {
  return !!(data && typeof data.access_token==="string" &&
    typeof data.refresh_token==="string" && Number(data.expires_in)>0);
}
async function spotifyToken(params) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(params),
    cache:"no-store",
  });
  const value = await response.json().catch(()=>({}));
  if (!response.ok) throw Error("Spotify OAuth HTTP " + response.status + ": " + (value.error||"unknown"));
  return value;
}
async function checkAdminKey(env, value) {
  if (typeof value!=="string" || value.length<24 || !env.PAIRING_KEY) return false;
  return await sha256(value)===await sha256(env.PAIRING_KEY);
}
function isMissingAdminTable(error) {
  return /no such table: admin_sessions|table admin_sessions does not exist/i.test(error?.message||"");
}
// This deliberately grants only invite creation. The raw PAIRING_KEY is never stored
// in localStorage, the session key only exists client-side, and D1 stores its hash.
async function checkAdminSession(env, token) {
  if(typeof token!=="string" || !VALID_ADMIN_SESSION.test(token))return null;
  const row=await env.DB.prepare(
    "SELECT expires_at,revoked_at FROM admin_sessions WHERE token_hash=?"
  ).bind(await sha256(token)).first();
  if(!row || row.revoked_at!==null && row.revoked_at!==undefined || Number(row.expires_at)<=Date.now())return null;
  return row;
}
async function activateAdmin(req,env) {
  const body=await bodyJson(req);
  if(!await checkAdminKey(env,body.pairingKey)) {
    return json({error:"unauthorized",message:"Неверный PAIRING_KEY владельца."},403,env);
  }
  const token=randomUrl(32), now=Date.now(), expiresAt=now+ADMIN_SESSION_MS;
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token_hash,created_at,expires_at) VALUES (?,?,?)"
  ).bind(await sha256(token),now,expiresAt).run();
  return json({adminSession:token,expiresAt},200,env);
}
async function adminStatus(req,env) {
  const body=await bodyJson(req);
  const row=await checkAdminSession(env,body.adminSession);
  if(!row)return json({error:"admin_session_expired",message:"Доступ владельца недействителен. Подтверди его повторно."},403,env);
  return json({active:true,expiresAt:row.expires_at},200,env);
}
async function revokeAdmin(req,env) {
  const body=await bodyJson(req);
  const token=body.adminSession;
  if(typeof token!=="string" || !VALID_ADMIN_SESSION.test(token)) {
    return json({error:"unauthorized"},403,env);
  }
  const revoked=await env.DB.prepare(
    "UPDATE admin_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? RETURNING token_hash"
  ).bind(Date.now(),await sha256(token),Date.now()).first();
  if(!revoked)return json({error:"admin_session_expired"},403,env);
  return json({revoked:true},200,env);
}
async function createInvite(req,env) {
  const body=await bodyJson(req);
  if (!await checkAdminKey(env,body.pairingKey) && !await checkAdminSession(env,body.adminSession)) {
    return json({error:"unauthorized",message:"Для приглашения нужен действующий доступ владельца."},403,env);
  }
  const code=randomUrl(24);
  const expiresAt=Date.now()+48*60*60*1000;
  try {
    await env.DB.prepare("INSERT INTO invites (token_hash,created_at,expires_at) VALUES (?,?,?)")
      .bind(await sha256(code),Date.now(),expiresAt).run();
  } catch(error) {
    if(/no such table: invites|table invites does not exist/i.test(error?.message||"")) {
      return json({error:"invites_not_ready",message:"Создай таблицу invites в Cloudflare D1 (инструкция на GitHub)."},503,env);
    }
    throw error;
  }
  return json({inviteCode:code,expiresAt},200,env);
}
async function connectStart(req,env) {
  const body=await bodyJson(req);
  const admin=await checkAdminKey(env,body.pairingKey);
  if(!admin) {
    // Single-use, 48-hour capability; invite holders never learn PAIRING_KEY.
    const invite=typeof body.invite==="string" ? body.invite : "";
    if(!/^[a-zA-Z0-9_-]{32}$/.test(invite)) {
      return json({error:"unauthorized",message:"Нужен ключ владельца или действующее приглашение."},403,env);
    }
    let accepted;
    try {
      accepted=await env.DB.prepare(
        "UPDATE invites SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING token_hash"
      ).bind(Date.now(),await sha256(invite),Date.now()).first();
    } catch(error) {
      if(/no such table: invites|table invites does not exist/i.test(error?.message||"")) {
        return json({error:"invites_not_ready",message:"Владелец ещё не настроил приглашения в Cloudflare D1."},503,env);
      }
      throw error;
    }
    if(!accepted) return json({error:"invalid_invite",message:"Приглашение истекло или уже использовано."},403,env);
  }
  const state=randomUrl(32);
  const verifier=randomUrl(64);
  const challenge=await sha256(verifier);
  const stateHash=await sha256(state);
  await env.DB.prepare("INSERT INTO pending_oauth (state_hash, verifier_cipher, created_at) VALUES (?,?,?)")
    .bind(stateHash,await seal(env,{verifier}),Date.now()).run();
  const redirect=new URL("/oauth/callback",req.url).toString();
  const url=new URL(AUTH_ENDPOINT);
  url.search=new URLSearchParams({
    client_id:env.SPOTIFY_CLIENT_ID,
    response_type:"code",
    redirect_uri:redirect,
    scope:"user-read-currently-playing",
    state,
    code_challenge_method:"S256",
    code_challenge:challenge,
  }).toString();
  return json({authorizeUrl:url.toString()},200,env);
}
async function oauthCallback(req,env) {
  const uri=new URL(req.url);
  const state=uri.searchParams.get("state")||"";
  const code=uri.searchParams.get("code");
  if (!state || !code || uri.searchParams.has("error")) return siteRedirect(env,"error=spotify_authorization_denied");
  const hash=await sha256(state);
  const row=await env.DB.prepare("SELECT verifier_cipher,created_at FROM pending_oauth WHERE state_hash=?")
    .bind(hash).first();
  if (!row || Date.now()-row.created_at>600000) return siteRedirect(env,"error=oauth_state_expired");
  // One-use OAuth state. D1 handles this as an atomic delete.
  const used=await env.DB.prepare("DELETE FROM pending_oauth WHERE state_hash=? RETURNING state_hash").bind(hash).first();
  if (!used) return siteRedirect(env,"error=oauth_state_reused");
  const verifier=(await unseal(env,row.verifier_cipher)).verifier;
  let tokens;
  try {
    tokens=await spotifyToken({
      grant_type:"authorization_code",code,code_verifier:verifier,
      client_id:env.SPOTIFY_CLIENT_ID,
      redirect_uri:new URL("/oauth/callback",req.url).toString(),
    });
  } catch(error) {
    console.error("Spotify OAuth callback failed:",error.message);
    return siteRedirect(env,"error=spotify_token_exchange");
  }
  if (!tokensValid(tokens)) return siteRedirect(env,"error=spotify_missing_refresh_token");
  const id=randomUrl(18);
  const viewKey=randomUrl(32);
  const ownerKey=randomUrl(32);
  const encrypted=await seal(env,{
    access_token:tokens.access_token,
    refresh_token:tokens.refresh_token,
    expires_at:Date.now()+Number(tokens.expires_in)*1000,
  });
  await env.DB.prepare(
    "INSERT INTO overlays (id,view_hash,owner_hash,token_cipher,created_at) VALUES (?,?,?,?,?)"
  ).bind(id,await sha256(viewKey),await sha256(ownerKey),encrypted,Date.now()).run();
  const hashFragment=new URLSearchParams({
    linked:id,view:viewKey,owner:ownerKey,api:new URL(req.url).origin,
  }).toString();
  return siteRedirect(env,hashFragment);
}
function validateKey(data, name) {
  return typeof data?.[name]==="string" && VALID_ID.test(data[name]);
}
async function getOverlay(env, data, owner=false) {
  if (!validateKey(data,"id") || !validateKey(data,owner?"ownerKey":"viewKey")) return null;
  const row=await env.DB.prepare("SELECT * FROM overlays WHERE id=?").bind(data.id).first();
  if (!row) return null;
  if (await sha256(data[owner?"ownerKey":"viewKey"])!==row[owner?"owner_hash":"view_hash"]) return null;
  return row;
}
async function ownerAction(req, env, path) {
  const data=await bodyJson(req);
  const row=await getOverlay(env,data,true);
  if (!row) return json({error:"unauthorized"},403,env);
  if (path==="/api/owner") return json({connected:true,createdAt:row.created_at},200,env);
  if (path==="/api/revoke") {
    await env.DB.prepare("DELETE FROM overlays WHERE id=? AND owner_hash=?").bind(row.id,row.owner_hash).run();
    return json({revoked:true},200,env);
  }
  if (path==="/api/rotate") {
    const viewKey=randomUrl(32);
    await env.DB.prepare("UPDATE overlays SET view_hash=?,cache_json=NULL,cache_until=0 WHERE id=?")
      .bind(await sha256(viewKey),row.id).run();
    return json({viewKey},200,env);
  }
  return json({error:"not_found"},404,env);
}
async function refreshToken(env,data) {
  const answer=await spotifyToken({
    grant_type:"refresh_token",
    client_id:env.SPOTIFY_CLIENT_ID,
    refresh_token:data.refresh_token,
  });
  if (!answer.access_token || !(Number(answer.expires_in)>0)) throw Error("Spotify token refresh failed");
  return {
    access_token:answer.access_token,
    refresh_token:answer.refresh_token || data.refresh_token,
    expires_at:Date.now()+Number(answer.expires_in)*1000,
  };
}
function projectCurrent(payload) {
  if (!payload || payload.is_playing!==true || !payload.item || payload.currently_playing_type==="ad") {
    return {playing:false};
  }
  const item=payload.item;
  const artists=Array.isArray(item.artists) ? item.artists.map(a=>a?.name).filter(Boolean).join(", ") : "";
  const spotifyUrl=typeof item.external_urls?.spotify==="string" ? item.external_urls.spotify :
    (/^[a-zA-Z0-9]{22}$/.test(item.id||"") ? "https://open.spotify.com/track/"+item.id : null);
  const image=(item.album?.images||item.images||item.show?.images||[]).find(i=>i?.url?.startsWith("https://"))?.url||null;
  return {
    playing:true,id:item.uri||item.id||String(item.name),
    title:String(item.name||"Без названия").slice(0,300),
    artist:String(artists||item.show?.name||"Spotify").slice(0,300),
    image,
    spotifyUrl,
    durationMs:Math.max(0,Number(item.duration_ms)||0),
    progressMs:Math.max(0,Number(payload.progress_ms)||0),
    observedAt:Date.now(),
  };
}
async function now(req,env) {
  const data=await bodyJson(req);
  const row=await getOverlay(env,data);
  if (!row) return json({error:"invalid_overlay_key"},403,env);
  const nowMs=Date.now();
  if (row.cache_json && row.cache_until>nowMs) return json(JSON.parse(row.cache_json),200,env);
  if (row.rate_limit_until>nowMs) {
    if(row.cache_json) return json({...JSON.parse(row.cache_json),stale:true},200,env);
    return json({error:"spotify_rate_limit",retryAfterMs:row.rate_limit_until-nowMs},429,env);
  }
  // Serialize Spotify refresh and currently-playing requests for this overlay.
  const lease=await env.DB.prepare(
    "UPDATE overlays SET lock_until=? WHERE id=? AND lock_until<? RETURNING id"
  ).bind(nowMs+LOCK_MS,row.id,nowMs).first();
  if (!lease) {
    if(row.cache_json) return json({...JSON.parse(row.cache_json),stale:true},200,env);
    return json({pending:true},202,env);
  }
  let tokens=await unseal(env,row.token_cipher);
  let released=false;
  try {
    if(tokens.expires_at-Date.now()<60000) tokens=await refreshToken(env,tokens);
    let response=await fetch(CURRENT_ENDPOINT,{
      headers:{Authorization:"Bearer "+tokens.access_token},
      cache:"no-store",
    });
    if(response.status===401) {
      tokens=await refreshToken(env,tokens);
      response=await fetch(CURRENT_ENDPOINT,{
        headers:{Authorization:"Bearer "+tokens.access_token},cache:"no-store",
      });
    }
    if(response.status===429) {
      const retry=Math.max(3000,Math.min(300000,Number(response.headers.get("Retry-After")||"60")*1000));
      await env.DB.prepare("UPDATE overlays SET rate_limit_until=?,lock_until=0,token_cipher=? WHERE id=?")
        .bind(Date.now()+retry,await seal(env,tokens),row.id).run();
      released=true;
      if(row.cache_json) return json({...JSON.parse(row.cache_json),stale:true},200,env);
      return json({error:"spotify_rate_limit",retryAfterMs:retry},429,env);
    }
    if(response.status===403) {
      return json({error:"spotify_forbidden",message:"Spotify ограничил доступ приложения (403)."},403,env);
    }
    if(!response.ok && response.status!==204) {
      return json({error:"spotify_api",status:response.status},502,env);
    }
    const raw=response.status===204 ? null : await response.json();
    const result=projectCurrent(raw);
    if(result.playing && !result.image) {
      // First ask oEmbed, then Spotify's supported single-track/album catalog API.
      // Negative artwork responses expire after 60 seconds rather than 24 hours.
      // Artwork failure is non-fatal: title and playback time still update.
      try { result.image=await resolveArtwork(env,raw.item,tokens); }
      catch(error) { console.warn("Artwork lookup failed:",error.message); }
    }
    await env.DB.prepare(
      "UPDATE overlays SET token_cipher=?,cache_json=?,cache_until=?,rate_limit_until=0,lock_until=0 WHERE id=?"
    ).bind(await seal(env,tokens),JSON.stringify(result),Date.now()+NOW_CACHE_MS,row.id).run();
    released=true;
    return json(result,200,env);
  } catch(error) {
    console.error("Spotify currently-playing error:",error.message);
    return json({error:"spotify_connection",message:"Не удалось обновить данные Spotify."},502,env);
  } finally {
    // Only unlock after early failures; success and 429 already released.
    if(!released)await env.DB.prepare("UPDATE overlays SET lock_until=0 WHERE id=?").bind(row.id).run();
  }
}
export default {
  async fetch(request,env) {
    if (!env.DB || !env.SPOTIFY_CLIENT_ID || !env.SITE_URL || !validSite(env)) {
      return new Response("Worker not configured (DB, SPOTIFY_CLIENT_ID, SITE_URL)",{status:503});
    }
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors(env)});
    if(url.pathname==="/api/health" && request.method==="GET") {
      return json({ready:!!(env.PAIRING_KEY && env.TOKEN_ENC_KEY)},200,env);
    }
    if(url.pathname==="/oauth/callback" && request.method==="GET") {
      try{return await oauthCallback(request,env);}
      catch(error){console.error(error.message);return siteRedirect(env,"error=oauth_callback_failed");}
    }
    // A third-party page must not send control commands via the visitor's browser.
    const origin=request.headers.get("Origin");
    if(origin && origin!==originOf(env)) return json({error:"origin_not_allowed"},403,env);
    if(request.method!=="POST") return json({error:"method_not_allowed"},405,env);
    try {
      if(url.pathname==="/oauth/start") return await connectStart(request,env);
      if(url.pathname==="/api/invite/create") return await createInvite(request,env);
      if(url.pathname==="/api/admin/activate") return await activateAdmin(request,env);
      if(url.pathname==="/api/admin/status") return await adminStatus(request,env);
      if(url.pathname==="/api/admin/revoke") return await revokeAdmin(request,env);
      if(url.pathname==="/api/now") return await now(request,env);
      if(["/api/owner","/api/revoke","/api/rotate"].includes(url.pathname)) {
        return await ownerAction(request,env,url.pathname);
      }
      return json({error:"not_found"},404,env);
    } catch(error) {
      if(isMissingAdminTable(error)) {
        return json({error:"admin_sessions_not_ready",message:"Не настроена таблица admin_sessions в Cloudflare D1. Открой инструкцию проекта."},503,env);
      }
      return json(safeError(error),500,env);
    }
  },
};

// Export selected pure helpers for regression tests without exposing secrets.
export {projectCurrent,seal,unseal};
