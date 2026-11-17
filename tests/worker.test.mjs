import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{projectCurrent,seal,unseal} from '../worker/src/index.js';

const env={
  DB:{},
  SPOTIFY_CLIENT_ID:'a'.repeat(32),
  SITE_URL:'https://witheroffic.github.io/spotify-widget-pkce/index.html',
  TOKEN_ENC_KEY:Buffer.from(new Uint8Array(32).fill(4)).toString('base64'),
  PAIRING_KEY:'secret_test_pairing_key_secret_123',
};

test('server only returns the public song fields',()=>{
  const song=projectCurrent({
    is_playing:true,progress_ms:1234,
    item:{
      id:'a'.repeat(22),uri:'spotify:track:'+'a'.repeat(22),
      name:'New track',duration_ms:240000,
      artists:[{name:'Artist A'},{name:'Artist B'}],
      album:{images:[{url:'https://i.scdn.co/cover'}]},
      external_urls:{spotify:'https://open.spotify.com/track/'+'a'.repeat(22)},
      secret_field:'never return',
    },
  });
  assert.equal(song.playing,true);
  assert.equal(song.artist,'Artist A, Artist B');
  assert.equal(song.image,'https://i.scdn.co/cover');
  assert.equal(song.progressMs,1234);
  assert.equal(song.spotifyUrl.startsWith('https://open.spotify.com/'),true);
  assert.equal(JSON.stringify(song).includes('secret_field'),false);
  assert.equal(projectCurrent(null).playing,false);
  assert.equal(projectCurrent({is_playing:false,item:{}}).playing,false);
});

test('server encrypts Spotify refresh token before persistence',async()=>{
  const encrypted=await seal(env,{refresh_token:'sensitive-user-refresh-token'});
  assert.equal(encrypted.includes('sensitive-user-refresh-token'),false);
  assert.deepEqual(await unseal(env,encrypted),{refresh_token:'sensitive-user-refresh-token'});
});

test('worker health is public but does not expose secrets',async()=>{
  const req=new Request('https://example.workers.dev/api/health',{
    headers:{Origin:'https://witheroffic.github.io'},
  });
  const res=await worker.fetch(req,env);
  assert.equal(res.status,200);
  const data=await res.json();
  assert.deepEqual(data,{ready:true});
  assert.equal(JSON.stringify(data).includes(env.PAIRING_KEY),false);
  assert.equal(res.headers.get('access-control-allow-origin'),'https://witheroffic.github.io');
});

test('worker rejects foreign browser origins',async()=>{
  const res=await worker.fetch(new Request('https://example.workers.dev/api/now',{
    method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},
    body:JSON.stringify({id:'a'.repeat(24),viewKey:'b'.repeat(43)}),
  }),env);
  assert.equal(res.status,403);
  assert.equal((await res.json()).error,'origin_not_allowed');
});

test('worker fails closed if backend is not configured',async()=>{
  const res=await worker.fetch(new Request('https://example.workers.dev/api/health'),{
    SITE_URL:env.SITE_URL,SPOTIFY_CLIENT_ID:env.SPOTIFY_CLIENT_ID,
  });
  assert.equal(res.status,503);
});

test('Spotify OAuth starts through Worker with PKCE and no browser refresh token',async()=>{
  const statements=[];
  const db={
    prepare(sql){
      return {
        bind(...values){
          return {run:async()=>{statements.push({sql,values});return {success:true}}};
        },
      };
    },
  };
  const req=new Request('https://example.workers.dev/oauth/start',{
    method:'POST',
    headers:{Origin:'https://witheroffic.github.io','Content-Type':'application/json'},
    body:JSON.stringify({pairingKey:env.PAIRING_KEY}),
  });
  const res=await worker.fetch(req,{...env,DB:db});
  assert.equal(res.status,200);
  const data=await res.json();
  const url=new URL(data.authorizeUrl);
  assert.equal(url.origin,'https://accounts.spotify.com');
  assert.equal(url.searchParams.get('client_id'),env.SPOTIFY_CLIENT_ID);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('redirect_uri'),'https://example.workers.dev/oauth/callback');
  assert.equal(url.searchParams.get('scope'),'user-read-currently-playing');
  assert.ok(url.searchParams.get('state').length>30);
  assert.equal(JSON.stringify(data).includes(env.PAIRING_KEY),false);
  assert.equal(statements.length,1);
  assert.ok(statements[0].sql.includes('INSERT INTO pending_oauth'));
  assert.equal(statements[0].values[1].includes('verifier'),false);
});

test('Spotify OAuth rejects requests without the pairing secret',async()=>{
  const response=await worker.fetch(new Request('https://example.workers.dev/oauth/start',{
    method:'POST',headers:{Origin:'https://witheroffic.github.io','Content-Type':'application/json'},
    body:JSON.stringify({pairingKey:'wrong'}),
  }),env);
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'unauthorized');
});

test('an unknown OBS viewer key receives no Spotify credentials',async()=>{
  const db={
    prepare(){
      return {bind(){return {first:async()=>null}}};
    },
  };
  const response=await worker.fetch(new Request('https://example.workers.dev/api/now',{
    method:'POST',headers:{Origin:'https://witheroffic.github.io','Content-Type':'application/json'},
    body:JSON.stringify({id:'a'.repeat(24),viewKey:'b'.repeat(43)}),
  }),{...env,DB:db});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'invalid_overlay_key');
});

test('owner creates one-time invitation without exposing the PAIRING_KEY',async()=>{
  const records=[];
  const db={
    prepare(sql){return {bind(...values){return {run:async()=>{
      records.push({sql,values});return {success:true};
    }}}}},
  };
  const response=await worker.fetch(new Request('https://example.workers.dev/api/invite/create',{
    method:'POST',headers:{Origin:'https://witheroffic.github.io','Content-Type':'application/json'},
    body:JSON.stringify({pairingKey:env.PAIRING_KEY}),
  }),{...env,DB:db});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.match(result.inviteCode,/^[a-zA-Z0-9_-]{32}$/);
  assert.ok(result.expiresAt>Date.now());
  assert.equal(records.length,1);
  assert.match(records[0].sql,/INSERT INTO invites/);
  assert.notEqual(records[0].values[0],result.inviteCode);
  assert.ok(!JSON.stringify(result).includes(env.PAIRING_KEY));
});

test('friend invitation is consumed atomically and never requires admin key',async()=>{
  let redeemed=0;
  let pending=0;
  const db={prepare(sql){return {bind(...values){
    if(sql.includes('UPDATE invites'))return {first:async()=>{
      redeemed++;
      return {token_hash:'hash'};
    }};
    if(sql.includes('INSERT INTO pending_oauth'))return {run:async()=>{
      pending++;
      return {success:true};
    }};
    throw Error('Unexpected SQL');
  }}}};
  const invitation='b'.repeat(32);
  const response=await worker.fetch(new Request('https://example.workers.dev/oauth/start',{
    method:'POST',headers:{Origin:'https://witheroffic.github.io','Content-Type':'application/json'},
    body:JSON.stringify({invite:invitation}),
  }),{...env,DB:db});
  assert.equal(response.status,200);
  const data=await response.json();
  assert.match(data.authorizeUrl,/accounts\.spotify\.com/);
  assert.equal(redeemed,1);
  assert.equal(pending,1);
});

test('an expired or consumed invitation is rejected',async()=>{
  const db={prepare(sql){return {bind(){
    assert.match(sql,/UPDATE invites/);
    return {first:async()=>null};
  }}}};
  const response=await worker.fetch(new Request('https://example.workers.dev/oauth/start',{
    method:'POST',headers:{Origin:'https://witheroffic.github.io','Content-Type':'application/json'},
    body:JSON.stringify({invite:'b'.repeat(32)}),
  }),{...env,DB:db});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'invalid_invite');
});

test('public invitation endpoint does not mint invites without pairing key',async()=>{
  const response=await worker.fetch(new Request('https://example.workers.dev/api/invite/create',{
    method:'POST',headers:{Origin:'https://witheroffic.github.io','Content-Type':'application/json'},
    body:JSON.stringify({pairingKey:'bad'}),
  }),env);
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'unauthorized');
});

function adminDB(){
  const sessions=new Map(),invites=[];
  return {
    sessions,invites,
    prepare(sql){
      return {bind(...args){
        return {
          async run(){
            if(sql.includes("INSERT INTO admin_sessions")){
              sessions.set(args[0],{expires_at:args[2],revoked_at:null});
            }else if(sql.includes("INSERT INTO invites")){
              invites.push(args);
            }else{
              throw Error("Unexpected D1 run: "+sql);
            }
            return {success:true};
          },
          async first(){
            if(sql.includes("SELECT expires_at,revoked_at FROM admin_sessions")){
              return sessions.get(args[0])||null;
            }
            if(sql.includes("UPDATE admin_sessions SET revoked_at=")){
              const row=sessions.get(args[1]);
              if(!row || row.revoked_at!==null || row.expires_at<=args[2])return null;
              row.revoked_at=args[0];
              return {token_hash:args[1]};
            }
            throw Error("Unexpected D1 first: "+sql);
          },
        };
      }};
    },
  };
}
async function adminPost(db,path,data){
  return worker.fetch(new Request("https://example.workers.dev"+path,{
    method:"POST",
    headers:{Origin:"https://witheroffic.github.io","Content-Type":"application/json"},
    body:JSON.stringify(data),
  }),{...env,DB:db});
}

test("admin activation stores only a session hash and never the pairing secret",async()=>{
  const db=adminDB();
  const response=await adminPost(db,"/api/admin/activate",{pairingKey:env.PAIRING_KEY});
  assert.equal(response.status,200);
  const data=await response.json();
  assert.match(data.adminSession,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(db.sessions.size,1);
  assert.ok(![...db.sessions.keys()].includes(data.adminSession));
  assert.ok(!JSON.stringify([...db.sessions]).includes(env.PAIRING_KEY));
  assert.ok(data.expiresAt>Date.now()+89*24*60*60*1000);
  assert.ok(!JSON.stringify(data).includes(env.PAIRING_KEY));
});
test("admin session can create an invite, but Spotify viewer/owner credentials cannot",async()=>{
  const db=adminDB();
  const activated=await adminPost(db,"/api/admin/activate",{pairingKey:env.PAIRING_KEY});
  const {adminSession}=await activated.json();
  const status=await adminPost(db,"/api/admin/status",{adminSession});
  assert.equal(status.status,200);
  assert.equal((await status.json()).active,true);
  const made=await adminPost(db,"/api/invite/create",{adminSession});
  assert.equal(made.status,200);
  assert.match((await made.json()).inviteCode,/^[A-Za-z0-9_-]{32}$/);
  assert.equal(db.invites.length,1);
  for(const props of [{ownerKey:"b".repeat(43)},{viewKey:"c".repeat(43)},
    {adminSession:"d".repeat(43)}]){
    const denied=await adminPost(db,"/api/invite/create",props);
    assert.equal(denied.status,403);
  }
});
test("revocation invalidates invite creation and cannot revoke another random session",async()=>{
  const db=adminDB();
  const activated=await adminPost(db,"/api/admin/activate",{pairingKey:env.PAIRING_KEY});
  const {adminSession}=await activated.json();
  const invalid=await adminPost(db,"/api/admin/revoke",{adminSession:"d".repeat(43)});
  assert.equal(invalid.status,403);
  const revoked=await adminPost(db,"/api/admin/revoke",{adminSession});
  assert.equal(revoked.status,200);
  assert.deepEqual(await revoked.json(),{revoked:true});
  assert.equal((await adminPost(db,"/api/admin/status",{adminSession})).status,403);
  assert.equal((await adminPost(db,"/api/invite/create",{adminSession})).status,403);
  assert.equal((await adminPost(db,"/api/admin/revoke",{adminSession})).status,403);
});
test("expired sessions are rejected even if client continues to hold a token",async()=>{
  const db=adminDB();
  const activated=await adminPost(db,"/api/admin/activate",{pairingKey:env.PAIRING_KEY});
  const {adminSession}=await activated.json();
  for(const row of db.sessions.values())row.expires_at=Date.now()-1000;
  assert.equal((await adminPost(db,"/api/admin/status",{adminSession})).status,403);
  assert.equal((await adminPost(db,"/api/invite/create",{adminSession})).status,403);
});
test("missing admin_sessions table returns actionable error, not raw D1 failure",async()=>{
  const db={prepare(){throw Error("D1_ERROR: no such table: admin_sessions");}};
  const r=await adminPost(db,"/api/admin/activate",{pairingKey:env.PAIRING_KEY});
  assert.equal(r.status,503);
  const data=await r.json();
  assert.equal(data.error,"admin_sessions_not_ready");
  assert.match(data.message,/D1/);
});
test("admin activation refuses an incorrect pairing key even with a valid Spotify connection",async()=>{
  const r=await adminPost(adminDB(),"/api/admin/activate",{
    pairingKey:"wrong",ownerKey:"o".repeat(43),
  });
  assert.equal(r.status,403);
});
