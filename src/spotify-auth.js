/*
 * Wither Spotify Widget — browser-only Spotify OAuth PKCE.
 * Modified 2026-11-17. GPL-3.0-or-later; see LICENSE.
 * Never place refresh tokens or client secrets in a browser-source URL.
 */
export const AUTH_KEYS = Object.freeze({
  clientId:'nutty-pkce-v1-client-id', // Keep previous storage key for user session migration.
  tokens:'nutty-pkce-v1-tokens',
  verifier:'nutty-pkce-v1-verifier',
  state:'nutty-pkce-v1-state',
});
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SCOPES = 'user-read-currently-playing';
const validClientId = text => /^[a-zA-Z0-9]{16,64}$/.test(text || '');

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
function makeNonce(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64Url(bytes);
}
export class SpotifyAuth {
  constructor({
    redirectUri,
    storage = localStorage,
    session = sessionStorage,
    request = fetch,
  }) {
    this.redirectUri = redirectUri;
    this.storage = storage;
    this.session = session;
    this.request = request;
    this.clientId = storage.getItem(AUTH_KEYS.clientId) || '';
    this.tokens = this.readTokens();
    this.refreshPromise = null;
  }
  get hasSession() { return Boolean(this.tokens?.refresh_token && this.clientId); }
  readTokens() {
    try {
      const value=JSON.parse(this.storage.getItem(AUTH_KEYS.tokens) || 'null');
      return value?.refresh_token && typeof value.refresh_token === 'string' ? value : null;
    } catch { return null; }
  }
  setClientId(id) {
    if (!validClientId(id)) throw Error('Неверный Client ID. Скопируй идентификатор приложения Spotify Developer.');
    if (this.clientId && this.clientId !== id) this.clearTokens();
    this.clientId = id;
    this.storage.setItem(AUTH_KEYS.clientId,id);
  }
  saveTokens(result) {
    if (!result?.access_token || !(Number(result.expires_in) > 0)) {
      throw Error('Spotify вернул некорректный access token.');
    }
    const refresh = result.refresh_token || this.tokens?.refresh_token;
    if (!refresh) throw Error('Spotify не прислал refresh token. Повтори подключение.');
    this.tokens = {
      access_token:result.access_token,
      refresh_token:refresh,
      expires_at:Date.now() + Number(result.expires_in)*1000,
    };
    this.storage.setItem(AUTH_KEYS.tokens,JSON.stringify(this.tokens));
  }
  clearTokens() {
    this.tokens = null;
    this.storage.removeItem(AUTH_KEYS.tokens);
  }
  disconnect() {
    this.clearTokens();
    this.session.removeItem(AUTH_KEYS.verifier);
    this.session.removeItem(AUTH_KEYS.state);
  }
  async tokenRequest(form) {
    const response=await this.request(TOKEN_URL,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams(form),cache:'no-store',
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok) {
      const error=new Error(`Spotify OAuth ${response.status}: ${payload.error_description || payload.error || response.statusText}`);
      error.code=payload.error;
      throw error;
    }
    return payload;
  }
  async startConnect(id) {
    this.setClientId(id);
    if(!window.isSecureContext || !crypto?.subtle) {
      throw Error('Spotify OAuth PKCE требует HTTPS (или разрешённый loopback-адрес).');
    }
    const verifier=makeNonce(64);
    const state=makeNonce(32);
    this.session.setItem(AUTH_KEYS.verifier,verifier);
    this.session.setItem(AUTH_KEYS.state,state);
    const url=new URL(AUTHORIZE_URL);
    url.search=new URLSearchParams({
      response_type:'code',client_id:this.clientId,scope:SCOPES,
      redirect_uri:this.redirectUri,state,
      code_challenge_method:'S256',code_challenge:await challenge(verifier),
    }).toString();
    window.location.assign(url.toString());
  }
  async completeRedirect(params) {
    if(!params.has('code') && !params.has('error')) return false;
    const expectedState=this.session.getItem(AUTH_KEYS.state);
    const verifier=this.session.getItem(AUTH_KEYS.verifier);
    const receivedState=params.get('state');
    // The browser keeps the authorization code out of address bar and history.
    history.replaceState(null,'',this.redirectUri);
    this.session.removeItem(AUTH_KEYS.state);
    this.session.removeItem(AUTH_KEYS.verifier);
    if(!expectedState || receivedState !== expectedState || !verifier) {
      throw Error('OAuth state/PKCE не совпал. Повтори авторизацию в том же браузере.');
    }
    if(params.has('error')) throw Error(`Spotify отказал в доступе: ${params.get('error')}`);
    if(!this.clientId) throw Error('Client ID отсутствует после OAuth.');
    const result=await this.tokenRequest({
      grant_type:'authorization_code',code:params.get('code'),
      redirect_uri:this.redirectUri,client_id:this.clientId,code_verifier:verifier,
    });
    this.saveTokens(result);
    return true;
  }
  async refresh() {
    if(!this.hasSession) throw Error('Нет Spotify refresh token. Требуется повторная авторизация.');
    if(this.refreshPromise) return this.refreshPromise;
    this.refreshPromise=(async()=>{
      try{
        const data=await this.tokenRequest({
          grant_type:'refresh_token',
          refresh_token:this.tokens.refresh_token,
          client_id:this.clientId,
        });
        this.saveTokens(data);
        return this.tokens.access_token;
      }catch(error){
        if(error.code==='invalid_grant'||error.code==='invalid_client') this.clearTokens();
        throw error;
      }finally{
        this.refreshPromise=null;
      }
    })();
    return this.refreshPromise;
  }
  async accessToken(force=false) {
    if(!this.clientId) throw Error('Client ID не задан.');
    if(!force && this.tokens?.access_token && this.tokens.expires_at-Date.now()>90000) {
      return this.tokens.access_token;
    }
    return this.refresh();
  }
  async authorizedFetch(url) {
    let token=await this.accessToken();
    let response=await this.request(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    if(response.status===401){
      token=await this.accessToken(true);
      response=await this.request(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    }
    return response;
  }
  exportConnection() {
    if(!this.hasSession) throw Error('Сначала подключи Spotify.');
    return {version:1,client_id:this.clientId,refresh_token:this.tokens.refresh_token};
  }
  importConnection(raw) {
    const bundle=JSON.parse(raw);
    if(bundle?.version!==1 || !validClientId(bundle.client_id) ||
      typeof bundle.refresh_token!=='string' ||
      bundle.refresh_token.length<20 || bundle.refresh_token.length>4096) {
      throw Error('Недопустимые данные импорта.');
    }
    this.setClientId(bundle.client_id);
    this.tokens={access_token:'',refresh_token:bundle.refresh_token,expires_at:0};
    this.storage.setItem(AUTH_KEYS.tokens,JSON.stringify(this.tokens));
  }
}
