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
  assert.match(page,/id="adminPairingKey" type="password"/);
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
});
