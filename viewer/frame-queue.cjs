'use strict';

// Bound image traffic by frames actually displayed, not just bytes written to TCP.
class FrameQueue {
  constructor(send, {maxInFlight=2, minIntervalMs=40}={}) {
    this.send=send;this.maxInFlight=maxInFlight;this.minIntervalMs=minIntervalMs;
    this.pending=null;this.inFlight=new Set();this.sequence=0;this.lastSent=0;this.active=true;
  }
  offer(frame) { if(this.active){this.pending=frame;this.flush();} }
  flush() {
    if(!this.active||!this.pending||this.inFlight.size>=this.maxInFlight)return;
    const delay=this.lastSent+this.minIntervalMs-Date.now();
    if(delay>0){this.retry(delay);return;}
    const frameId=this.sequence+1;
    if(!this.send({...this.pending,frameId})){this.retry(25);return;}
    this.sequence=frameId;this.inFlight.add(frameId);this.pending=null;this.lastSent=Date.now();
  }
  retry(delay) { if(!this.timer){this.timer=setTimeout(()=>{this.timer=null;this.flush();},delay);this.timer.unref?.();} }
  acknowledge(frameId) { if(this.inFlight.delete(frameId))this.flush(); }
  pause() { this.active=false;this.pending=null;this.inFlight.clear();clearTimeout(this.timer);this.timer=null; }
  resume() { this.active=true; }
}
module.exports={FrameQueue};
