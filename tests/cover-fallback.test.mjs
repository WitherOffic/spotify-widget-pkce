import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveArtwork,findCover,NO_COVER_CACHE_MS} from '../worker/src/artwork.js';
import {publicSpotifyId,publicThumbnail} from '../src/public-artwork.js';

const id='1rT2BmlIKlvmDIbAkHWG2Z';
const art='https://i.scdn.co/image/example';
function database(cached=null) {
  const state={cached,stored:[]};
  return {
    state,
    DB:{
      prepare(sql){
        return {bind(...values){
          return {
            first:async()=>state.cached,
            run:async()=>{state.stored.push({sql,values});return {success:true}},
          };
        }};
      },
    },
  };
}
test('findCover handles missing image arrays and chooses HTTPS cover',()=>{
  assert.equal(findCover({album:{images:[{url:'http://nope'},null,{url:art}]}}),art);
  assert.equal(findCover({album:{images:[]}}),null);
  assert.equal(findCover({show:{images:[{url:art}]}}),art);
});

test('Worker falls back to Spotify catalog when hosted oEmbed is blocked',async()=>{
  const d=database();
  const calls=[];
  const image=await resolveArtwork({DB:d.DB},{id,type:'track'}, {access_token:'private-token'}, {
    clock:()=>1_000_000,
    fetchFn:async(url,options)=>{
      calls.push({url,options});
      if(url.includes('/oembed'))return {ok:false,status:403};
      if(url.includes('/tracks/'))return {ok:true,json:async()=>({album:{images:[{url:art}]}})};
      throw Error('Unexpected URL: '+url);
    },
  });
  assert.equal(image,art);
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.headers.Authorization,'Bearer private-token');
  assert.ok(d.state.stored.some(v=>v.values[1]===art));
});

test('Old negative D1 cache is retried rather than blocking art for a day',async()=>{
  const d=database({url:null,checked_at:1});
  let calls=0;
  const value=await resolveArtwork({DB:d.DB},{id,type:'track'},{access_token:'token'},{
    clock:()=>NO_COVER_CACHE_MS+120_000,
    fetchFn:async(url)=>{
      calls++;
      if(url.includes('/oembed'))return {ok:true,json:async()=>({thumbnail_url:art})};
      throw Error('Catalog should not be needed');
    },
  });
  assert.equal(value,art);
  assert.equal(calls,1);
});
test('Fresh negative cache prevents unbounded repeat requests',async()=>{
  const d=database({url:null,checked_at:1_000_000});
  const value=await resolveArtwork({DB:d.DB},{id,type:'track'},null,{
    clock:()=>1_001_000,fetchFn:async()=>{throw Error('should not be called');},
  });
  assert.equal(value,null);
});
test('Browser fallback supports track link and no Spotify tokens',async()=>{
  assert.deepEqual(publicSpotifyId({spotifyUrl:'https://open.spotify.com/track/'+id}),{kind:'track',id});
  let sent='';
  const output=await publicThumbnail({id:'spotify:track:'+id},async(url)=>{
    sent=url;
    return {ok:true,json:async()=>({thumbnail_url:art})};
  });
  assert.equal(output,art);
  assert.match(sent,/open.spotify.com\/oembed/);
  assert.match(decodeURIComponent(sent),new RegExp(id));
});
