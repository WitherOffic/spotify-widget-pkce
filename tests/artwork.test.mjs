import test from 'node:test';
import assert from 'node:assert/strict';
import { firstImageUrl, spotifyItemId } from '../src/artwork.js';

test('selects a secure album cover and ignores malformed image entries',()=>{
  const model={
    album:{images:[null,{url:'http://unsafe.example/x.jpg'},{url:'https://i.scdn.co/good'}]},
  };
  assert.equal(firstImageUrl(model),'https://i.scdn.co/good');
  assert.equal(firstImageUrl(model,new Set(['https://i.scdn.co/good'])),null);
});
test('supports episode/show images and empty image lists',()=>{
  assert.equal(firstImageUrl({show:{images:[{url:'https://i.scdn.co/episode'}]}}),'https://i.scdn.co/episode');
  assert.equal(firstImageUrl({album:{images:[]}}),null);
});
test('validates identifiers from Spotify URI or id',()=>{
  const valid='a'.repeat(22);
  assert.equal(spotifyItemId({uri:'spotify:track:'+valid}),valid);
  assert.equal(spotifyItemId({id:valid}),valid);
  assert.equal(spotifyItemId({uri:'spotify:track:demo'}),null);
});
