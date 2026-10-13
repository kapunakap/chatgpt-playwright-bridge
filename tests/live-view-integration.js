'use strict';
// Run inside live-view with a temporary token file. Attaches to the existing browser only.
const assert=require('node:assert/strict'), fs=require('node:fs');
const {ws:WebSocket}=require('/app/node_modules/playwright-core/lib/utilsBundle.js');
const {createClient,extractJsonObject}=require('/opt/tab-reaper.cjs');
const token=fs.readFileSync('/run/live-view/test-token','utf8').trim();
const client=createClient('http://127.0.0.1:8931/mcp');
const messages=[];let ws;
async function waitFor(fn,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){const r=fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw new Error('Acceptance timeout');}
async function run(code){const r=await client.request('tools/call',{name:'browser_run_code_unsafe',arguments:{code}});return JSON.parse(extractJsonObject(r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n')));}
async function main(){
 console.log('begin');
 await client.request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'live-view-test',version:'1'}});await client.notify('notifications/initialized');
 console.log('initialized');
 const original=await run('async page=>({index:page.context().pages().indexOf(page),count:page.context().pages().length})');
 await client.request('tools/call',{name:'browser_tabs',arguments:{action:'new'}});
 const fixture=`<title>Live View QA</title><input id="input" style="position:absolute;left:40px;top:40px;width:400px;height:40px"><button id="button" style="position:absolute;left:40px;top:100px" onclick="this.textContent='Clicked'">Click me</button><div style="height:3000px"></div>`;
 await run(`async page=>{await page.setContent(${JSON.stringify(fixture)});return {index:page.context().pages().indexOf(page)};}`);
 const fixtureIndex=(await run('async page=>({index:page.context().pages().indexOf(page)})')).index;
 try {
  console.log('fixture');
  const denied=await new Promise(resolve=>{const bad=new WebSocket('ws://127.0.0.1:6080/ws',['live-view','invalid'],{origin:'http://127.0.0.1:6080'});bad.on('unexpected-response',(_,r)=>{resolve(r.statusCode);r.resume();});bad.on('error',()=>{});});assert.equal(denied,403);console.log('auth');
  ws=new WebSocket('ws://127.0.0.1:6080/ws',['live-view',token],{origin:'http://127.0.0.1:6080'});ws.on('message',d=>messages.push(JSON.parse(d)));await new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',reject);});
  console.log('websocket');
  const frame=await waitFor(()=>messages.find(x=>x.type==='frame'));assert.equal(Buffer.from(frame.data,'base64').subarray(0,2).toString('hex'),'ffd8');
  await waitFor(()=>messages.find(x=>x.type==='state'));
  ws.send(JSON.stringify({type:'text',text:'must-not-type'}));await new Promise(r=>setTimeout(r,300));assert.equal((await run('async page=>({value:await page.locator("#input").inputValue()})')).value,'');
  ws.send(JSON.stringify({type:'control',enabled:true}));await waitFor(()=>messages.find(x=>x.type==='control'&&x.enabled));
  for(const event of ['mousePressed','mouseReleased'])ws.send(JSON.stringify({type:'mouse',event,x:80,y:60,button:'left',buttons:event==='mousePressed'?1:0}));
  ws.send(JSON.stringify({type:'text',text:'viewer-to-mcp'}));await new Promise(r=>setTimeout(r,500));assert.equal((await run('async page=>({value:await page.locator("#input").inputValue()})')).value,'viewer-to-mcp');
  for(const event of ['keyDown','keyUp'])ws.send(JSON.stringify({type:'key',event,key:'Backspace',code:'Backspace',keyCode:8}));await new Promise(r=>setTimeout(r,300));assert.equal((await run('async page=>({value:await page.locator("#input").inputValue()})')).value,'viewer-to-mc');
  for(const event of ['mousePressed','mouseReleased'])ws.send(JSON.stringify({type:'mouse',event,x:70,y:110,button:'left',buttons:event==='mousePressed'?1:0}));await new Promise(r=>setTimeout(r,300));assert.equal((await run('async page=>({text:await page.locator("#button").textContent()})')).text,'Clicked');
  ws.send(JSON.stringify({type:'wheel',x:500,y:300,dx:0,dy:350}));await new Promise(r=>setTimeout(r,300));assert((await run('async page=>({scroll:await page.evaluate(()=>scrollY)})')).scroll>0);
  const before=messages.filter(x=>x.type==='frame').length;await run('async page=>{await page.locator("#input").fill("mcp-to-viewer");await page.evaluate(()=>scrollTo(0,0));return {ok:true};}');await waitFor(()=>messages.filter(x=>x.type==='frame').length>before);
  const listed=messages.filter(x=>x.type==='state').at(-1).tabs;const first=listed.find(x=>x.index===original.index);ws.send(JSON.stringify({type:'tab',id:first.id}));await new Promise(r=>setTimeout(r,2200));assert.equal((await run('async page=>({index:page.context().pages().indexOf(page)})')).index,original.index);
  await client.request('tools/call',{name:'browser_tabs',arguments:{action:'select',index:fixtureIndex}});await waitFor(()=>messages.filter(x=>x.type==='state').at(-1)?.tabs.some(x=>x.current&&x.index===fixtureIndex));
  ws.send(JSON.stringify({type:'control',enabled:false}));await new Promise(r=>setTimeout(r,300));
  const {chromium}=require('/app/node_modules/playwright-core');
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const viewer=await browser.contexts()[0].newPage();
  try {
   await viewer.goto('http://127.0.0.1:6080/#'+token);
   await viewer.locator('#status').filter({hasText:'Connected'}).waitFor();
   await viewer.locator('#control').check();
   await viewer.locator('#status').filter({hasText:'you have control'}).waitFor();
   await viewer.waitForFunction(()=>document.querySelector('#screen').width>300);
   await viewer.locator('#screen').click({position:{x:80,y:60}});
   await viewer.keyboard.press('End');await viewer.keyboard.type('-ui');
   await new Promise(r=>setTimeout(r,300));
   assert.equal((await run('async page=>({value:await page.locator("#input").inputValue()})')).value,'mcp-to-viewer-ui');
   await viewer.screenshot({path:'/tmp/live-view-ui.png'});
   await viewer.locator('#tabs .tab-select').nth(original.index).click();
   await new Promise(r=>setTimeout(r,1600));
   assert.equal((await run('async page=>({index:page.context().pages().indexOf(page)})')).index,original.index);
   // Closing a fixture from the rendered viewer must close only that shared target.
   await client.request('tools/call',{name:'browser_tabs',arguments:{action:'new'}});
   await run('async page=>{await page.setContent("<title>Close tab QA</title>");return {ok:true};}');
   await viewer.getByRole('button',{name:'Close tab: Close tab QA',exact:true}).click();
   for(let attempt=0;attempt<50;attempt++){
     const gone=await run('async page=>({gone:!(await Promise.all(page.context().pages().map(p=>p.title()))).includes("Close tab QA")})');
     if(gone.gone)break;
     if(attempt===49)throw new Error('Viewer close did not close shared tab');
     await new Promise(r=>setTimeout(r,100));
   }
   await viewer.reload();await viewer.locator('#status').filter({hasText:'Connected'}).waitFor();
  } finally {await viewer.close();await browser.close();}
  console.log('Rendered viewer UI click, typing, tabs, close and refresh passed');
  console.log(JSON.stringify({passed:true,authDenied:denied,jpegFrames:messages.filter(x=>x.type==='frame').length,readOnly:true,mouse:true,keyboard:true,scroll:true,tabs:true,mcpToViewer:true,viewerToMcp:true,renderedUI:true,closeTab:true}));
 } finally {
  if(ws)ws.close();await client.request('tools/call',{name:'browser_tabs',arguments:{action:'close',index:fixtureIndex}});await client.request('tools/call',{name:'browser_tabs',arguments:{action:'select',index:original.index}});
  // Keep the shared MCP session: deleting the last client closes Chromium upstream.
 }
}
main().then(()=>process.exit(0),e=>{console.error(e.stack);process.exit(1);});
