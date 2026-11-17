import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = path => readFileSync(new URL(path,import.meta.url),'utf8');

test('main URL is the setup dashboard, not the Spotify login in OBS',()=>{
  const index=html('../index.html');
  assert.match(index,/dashboard\.js/);
  assert.match(index,/Подключить Spotify/);
  assert.match(index,/overlayLink/);
  assert.doesNotMatch(index,/script\.js/);
});

test('OBS overlay is a separate source without direct Spotify credentials',()=>{
  const overlay=html('../overlay.html');
  assert.match(overlay,/overlay\.js/);
  assert.match(overlay,/spotifyAttribution/);
  assert.doesNotMatch(overlay,/Client ID/);
  assert.doesNotMatch(overlay,/refresh_token/);
});

test('secrets are not placed in Cloudflare worker config',()=>{
  const config=html('../worker/wrangler.toml');
  assert.match(config,/SITE_URL/);
  assert.match(config,/SPOTIFY_CLIENT_ID/);
  assert.doesNotMatch(config,/^TOKEN_ENC_KEY\s*=/m);
  assert.doesNotMatch(config,/^PAIRING_KEY\s*=/m);
});

test('dashboard offers secure OBS link, demo preview and invitation controls',()=>{
  const page=html('../index.html');
  assert.match(page,/id="overlayLink" type="password"/);
  assert.match(page,/id="demoPreview" src="\.\/overlay\.html\?demo=1"/);
  assert.match(page,/id="friendWelcome"/);
  assert.match(page,/id="createInvite"/);
  assert.match(page,/id="adminLoginKey" type="password"/);
  assert.match(page,/id="adminAccessArea"/);
  assert.match(page,/id="revokeAdmin"/);
  assert.doesNotMatch(page,/id="adminPairingKey"/);
  assert.match(page,/id="copyInvite"/);
  assert.match(page,/id="connectionBadge"/);
});

test('dashboard strips invitations from address bar and does not persist invite codes',()=>{
  const js=html('../dashboard.js');
  assert.match(js,/history\.replaceState/);
  assert.match(js,/activeInvite=invite/);
  assert.match(js,/\.hash=new URLSearchParams/);
  assert.doesNotMatch(js,/save\(ACCOUNT_KEY,activeInvite\)/);
});

test('D1 schema adds invites without altering existing overlays',()=>{
  const schema=html('../worker/schema.sql');
  assert.match(schema,/CREATE TABLE IF NOT EXISTS invites/);
  assert.match(schema,/used_at INTEGER/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS overlays/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS admin_sessions/);
  assert.match(schema,/revoked_at INTEGER/);
});

test('admin permission is scoped, server-validated and not shown to other connected accounts',()=>{
  const js=html('../dashboard.js');
  const worker=html('../worker/src/index.js');
  assert.match(js,/const ADMIN_KEY="wither-spotify-admin-session"/);
  assert.match(js,/adminSession:adminSession\.token/);
  assert.match(js,/adminVerified/);
  assert.match(js,/friendsArea\.hidden=!authorized/);
  assert.match(js,/localStorage\.removeItem\(ADMIN_KEY\)/);
  assert.doesNotMatch(js,/save\(ADMIN_KEY,\s*.*pairingKey\)/);
  assert.match(worker,/const ADMIN_SESSION_MS = 90 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(worker,/\/api\/admin\/activate/);
  assert.match(worker,/\/api\/admin\/revoke/);
  assert.match(worker,/\/api\/admin\/status/);
});

test('dashboard uses local scripts only and restricts active page content',()=>{
  const page=html('../index.html');
  assert.match(page,/http-equiv="Content-Security-Policy"/);
  assert.match(page,/script-src 'self'/);
  assert.doesNotMatch(page,/script src="https:\/\//);
});
