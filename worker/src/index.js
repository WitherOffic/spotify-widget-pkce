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
async function connectStart(req,env) {
  const body=await bodyJson(req);
  if (!body.pairingKey || typeof body.pairingKey!=="string" ||
      !env.PAIRING_KEY || await sha256(body.pairingKey)!==await sha256(env.PAIRING_KEY)) {
    return json({error:"unauthorized",message:"Неверный ключ подключения Worker."},403,env);
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
async function fallbackImage(env, itemId) {
  if (!/^[a-zA-Z0-9]{22}$/.test(itemId||"")) return null;
  const cached=await env.DB.prepare("SELECT url,checked_at FROM art_cache WHERE id=?").bind(itemId).first();
  if (cached && Date.now()-cached.checked_at<86400000) return cached.url||null;
  let url=null;
  try {
    const request=new URL("https://open.spotify.com/oembed");
    request.searchParams.set("url","https://open.spotify.com/track/"+itemId);
    const response=await fetch(request.toString(),{headers:{"Accept":"application/json"}});
    if(response.ok) {
      const j=await response.json();
      if(typeof j.thumbnail_url==="string" && j.thumbnail_url.startsWith("https://")) url=j.thumbnail_url;
    }
  } catch {}
  await env.DB.prepare(
    "INSERT INTO art_cache (id,url,checked_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,checked_at=excluded.checked_at"
  ).bind(itemId,url,Date.now()).run();
  return url;
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
      const id=/^[a-zA-Z0-9]{22}$/.test(raw.item?.id||"") ? raw.item.id : null;
      if(id) result.image=await fallbackImage(env,id);
    }
    await env.DB.prepare(
      "UPDATE overlays SET token_cipher=?,cache_json=?,cache_until=?,rate_limit_until=0,lock_until=0 WHERE id=?"
    ).bind(await seal(env,tokens),JSON.stringify(result),Date.now()+NOW_CACHE_MS,row.id).run();
    return json(result,200,env);
  } catch(error) {
    console.error("Spotify currently-playing error:",error.message);
    return json({error:"spotify_connection",message:"Не удалось обновить данные Spotify."},502,env);
  } finally {
    // Release on all paths; when success has already reset the lease this is harmless.
    await env.DB.prepare("UPDATE overlays SET lock_until=0 WHERE id=?").bind(row.id).run();
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
      if(url.pathname==="/api/now") return await now(request,env);
      if(["/api/owner","/api/revoke","/api/rotate"].includes(url.pathname)) {
        return await ownerAction(request,env,url.pathname);
      }
      return json({error:"not_found"},404,env);
    } catch(error) {
      return json(safeError(error),500,env);
    }
  },
};

// Export selected pure helpers for regression tests without exposing secrets.
export {projectCurrent,seal,unseal};
