'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FrameQueue}=require('../viewer/frame-queue.cjs');
function fixture(){const sent=[];const queue=new FrameQueue(frame=>{sent.push(frame);return true;},{minIntervalMs:0});return {sent,queue};}
test('a slow viewer receives the latest pending image instead of replaying stale images',()=>{
  const {sent,queue}=fixture();
  for(let frame=1;frame<=100;frame++)queue.offer({data:String(frame)});
  assert.deepEqual(sent.map(f=>f.data),['1','2']);
  queue.acknowledge(sent[0].frameId);
  assert.deepEqual(sent.map(f=>f.data),['1','2','100']);queue.pause();
});
test('duplicate or unknown acknowledgments cannot grow the outstanding window',()=>{
  const {sent,queue}=fixture();for(let frame=1;frame<=4;frame++)queue.offer({data:String(frame)});
  queue.acknowledge(999);assert.equal(sent.length,2);
  queue.acknowledge(1);queue.offer({data:'5'});queue.acknowledge(1);
  assert.equal(sent.length,3);assert.equal(queue.inFlight.size,2);queue.pause();
});
test('acknowledgments may arrive out of order without losing the latest image',()=>{
  const {sent,queue}=fixture();for(let frame=1;frame<=3;frame++)queue.offer({data:String(frame)});
  queue.acknowledge(2);assert.deepEqual(sent.map(f=>f.data),['1','2','3']);
  queue.acknowledge(1);queue.acknowledge(3);assert.equal(queue.inFlight.size,0);queue.pause();
});
test('pausing discards queued images and old acknowledgments cannot release a resumed window',()=>{
  const {sent,queue}=fixture();for(let frame=1;frame<=3;frame++)queue.offer({data:String(frame)});
  queue.pause();queue.offer({data:'hidden'});queue.resume();queue.offer({data:'visible'});
  queue.acknowledge(1);queue.acknowledge(2);
  assert.deepEqual(sent.map(f=>f.data),['1','2','visible']);assert.equal(queue.inFlight.size,1);queue.pause();
});
test('transport backpressure retains the latest image without consuming a frame credit',()=>{
  let writable=false;const sent=[];
  const queue=new FrameQueue(frame=>{if(!writable)return false;sent.push(frame);return true;},{minIntervalMs:0});
  queue.offer({data:'old'});queue.offer({data:'latest'});assert.equal(queue.inFlight.size,0);
  writable=true;queue.flush();assert.deepEqual(sent.map(f=>f.data),['latest']);queue.pause();
});
