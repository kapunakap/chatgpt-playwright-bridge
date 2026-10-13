'use strict';
// Uses the open-source ws implementation already bundled in the pinned MCP image.
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { wsServer } = require('/app/node_modules/playwright-core/lib/utilsBundle.js');
const { createClient, extractJsonObject } = require('/opt/tab-reaper.cjs');
const PORT = Number(process.env.LIVE_VIEW_PORT || 6080);
const ACCESS = process.env.LIVE_VIEW_ACCESS || '/run/live-view/access.json';
const MCP = process.env.LIVE_VIEW_MCP_URL || 'http://127.0.0.1:8931/mcp';
const clients = new Set();
let controller = null, cdp = null, target = '', tabs = [], busy = false;
function access(token) {
  try {
    const a = JSON.parse(fs.readFileSync(ACCESS, 'utf8'));
    const digest = crypto.createHash('sha256').update(token || '').digest('hex');
    return Date.now() < a.expires && a.hash.length === digest.length && crypto.timingSafeEqual(Buffer.from(a.hash), Buffer.from(digest));
  } catch { return false; }
}
function localRequest(req, requireOrigin = false) {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
  return (!requireOrigin && !req.headers.origin) || req.headers.origin === `http://${host}`;
}
function send(ws, message) { if (ws.readyState === 1 && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(message)); }
function broadcast(message) { for (const ws of clients) send(ws, message); }
let mcpClient;
async function tool(name, args) {
  for(let attempt=0; attempt<2; attempt++) {
    try {
      if(!mcpClient) {
        mcpClient=createClient(MCP);
        await mcpClient.request('initialize', {protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'live-view',version:'1.0.0'}});
        await mcpClient.notify('notifications/initialized');
      }
      return await mcpClient.request('tools/call', {name,arguments:args});
    } catch(error) {mcpClient=null;if(attempt)throw error;}
  }
  // Do not DELETE the MCP session: the upstream shared browser closes when its last client is deleted.
}
async function state() {
  const result = await tool('browser_run_code_unsafe', {code:`async (page) => {
    const pages = page.context().pages(); const tabs = [];
    for (let index=0; index<pages.length; index++) {
      const p=pages[index]; const s=await p.context().newCDPSession(p);
      try { const {targetInfo}=await s.send('Target.getTargetInfo');
        tabs.push({id:targetInfo.targetId,index,title:targetInfo.title,url:targetInfo.url,current:p===page});
      } finally {await s.detach();}
    } return {tabs};
  }`});
  return JSON.parse(extractJsonObject(result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))).tabs;
}
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.pending = new Map(); this.id = 0;
    this.ready = new Promise((resolve,reject)=>{this.ws.onopen=resolve;this.ws.onerror=()=>reject(new Error('CDP unavailable'));});
    this.ws.onmessage = event => {
      const m=JSON.parse(event.data);
      if(m.id) { const p=this.pending.get(m.id); if(p) {clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error('CDP command failed')):p.resolve(m.result);} }
      else if(m.method==='Page.screencastFrame') {
        broadcast({type:'frame',data:m.params.data,metadata:m.params.metadata});
        this.call('Page.screencastFrameAck',{sessionId:m.params.sessionId}).catch(()=>{});
      }
    };
    this.ws.onclose=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP disconnected'));}this.pending.clear();if(cdp===this){cdp=null;target='';broadcast({type:'status',message:'Browser reconnecting'});}};
  }
  async call(method,params={}) {
    await this.ready;
    return new Promise((resolve,reject)=>{const id=++this.id; const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout'));},5000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});
  }
  close(){this.ws.close();}
}
async function attach(id) {
  if(target===id && cdp) return;
  if(cdp){const old=cdp;cdp=null;await old.call('Page.stopScreencast').catch(()=>{});old.close();}
  const list=await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const found=list.find(t=>t.id===id); if(!found) throw new Error('Tab unavailable');
  const next=new CDP(found.webSocketDebuggerUrl);await next.ready; cdp=next;target=id;
  await next.call('Page.enable');
  await next.call('Page.startScreencast',{format:'jpeg',quality:70,maxWidth:1600,maxHeight:1000,everyNthFrame:1});
}
function number(n, min, max){if(!Number.isFinite(n)||n<min||n>max)throw new Error('Invalid input');return n;}
async function input(message) {
  if(!cdp) throw new Error('Browser unavailable');
  if(message.type==='mouse') {
    if(!['mouseMoved','mousePressed','mouseReleased'].includes(message.event))throw new Error('Invalid mouse event');
    const button=['none','left','middle','right'].includes(message.button)?message.button:'none';
    await cdp.call('Input.dispatchMouseEvent',{type:message.event,x:number(message.x,0,10000),y:number(message.y,0,10000),button,buttons:number(message.buttons||0,0,7),clickCount:message.event==='mouseMoved'?0:number(message.clickCount||1,1,3),modifiers:number(message.modifiers||0,0,15)});
  } else if(message.type==='wheel') {
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:number(message.x,0,10000),y:number(message.y,0,10000),deltaX:number(message.dx,-10000,10000),deltaY:number(message.dy,-10000,10000)});
  } else if(message.type==='key') {
    if(!['keyDown','keyUp'].includes(message.event)||typeof message.key!=='string'||message.key.length>40||typeof message.code!=='string'||message.code.length>40)throw new Error('Invalid key');
    await cdp.call('Input.dispatchKeyEvent',{type:message.event,key:message.key,code:message.code,windowsVirtualKeyCode:number(message.keyCode||0,0,255),modifiers:number(message.modifiers||0,0,15)});
  } else if(message.type==='text') {
    if(typeof message.text!=='string'||message.text.length>10000)throw new Error('Invalid text');
    await cdp.call('Input.insertText',{text:message.text});
  } else if(message.type==='tab') {
    const tab=tabs.find(t=>t.id===message.id);if(!tab)throw new Error('Tab unavailable');
    await tool('browser_tabs',{action:'select',index:tab.index});await refresh();
  } else throw new Error('Invalid action');
}
async function refresh() {
  if(busy||!clients.size)return;busy=true;
  try {
    tabs=await state(); const current=tabs.find(t=>t.current)||tabs[0];
    if(current)await attach(current.id);
    // Keep a displayed tab alive even during read-only viewing. No page content is logged.
    if(cdp)await cdp.call('Runtime.evaluate',{expression:`(() => { const s=globalThis[Symbol.for('chatgpt.playwright.tab-reaper.activity-v2')]; if(s) s.lastActivity=Date.now(); })()`});
    broadcast({type:'state',tabs,controller:!!controller});
  } catch(error) {console.error('Viewer refresh unavailable');broadcast({type:'status',message:'Browser reconnecting; retrying automatically'});}
  finally {busy=false;}
}
const server=http.createServer((req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self'; script-src 'self'; frame-ancestors 'none'"};
  if(!localRequest(req)){res.writeHead(403,headers);return res.end('Forbidden');}
  const files={'/':'index.html','/client.js':'client.js','/style.css':'style.css'};
  if(req.url==='/health'){res.writeHead(200,headers);return res.end('ok');}
  const file=files[req.url];if(!file||req.method!=='GET'){res.writeHead(404,headers);return res.end();}
  res.writeHead(200,{...headers,'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(`${__dirname}/${file}`));
});
const wss=new wsServer({noServer:true,maxPayload:20000,handleProtocols:()=> 'live-view'});
server.on('upgrade',(req,socket,head)=>{
  const protocols=(req.headers['sec-websocket-protocol']||'').split(',').map(x=>x.trim());
  if(req.url!=='/ws'||!localRequest(req,true)||protocols[0]!=='live-view'||!access(protocols[1])){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>{ws.token=protocols[1];wss.emit('connection',ws);});
});
wss.on('connection',ws=>{
  clients.add(ws);send(ws,{type:'status',message:'Connected — read-only'});refresh();
  let chain=Promise.resolve();
  ws.on('message',data=>{chain=chain.then(async()=>{
    if(!access(ws.token)){ws.close(1008,'Access expired');return;}
    const m=JSON.parse(data.toString());
    if(m.type==='control'){if(m.enabled){if(controller&&controller!==ws)throw new Error('Another viewer has control');controller=ws;}else if(controller===ws)controller=null;send(ws,{type:'control',enabled:controller===ws});return;}
    if(controller!==ws)throw new Error('Enable control first');await input(m);
  }).catch(()=>send(ws,{type:'status',message:'Action unavailable; check control and connection'}));});
  ws.on('close',()=>{clients.delete(ws);if(controller===ws)controller=null;if(!clients.size&&cdp){const old=cdp;cdp=null;target='';old.call('Page.stopScreencast').finally(()=>old.close()).catch(()=>{});}});
});
const timer=setInterval(()=>{for(const ws of clients)if(!access(ws.token))ws.close(1008,'Access expired');refresh();},1500);
server.listen(PORT,'0.0.0.0',()=>console.log('Live viewer ready'));
process.on('SIGTERM',()=>{clearInterval(timer);for(const ws of clients)ws.close();if(cdp)cdp.close();server.close(()=>process.exit(0));});
