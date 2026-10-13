'use strict';
// Run only through SSM during a controlled rollout. Output contains counts only.
const fs=require('node:fs'),crypto=require('node:crypto');
const {createClient,extractJsonObject}=require('/opt/playwright-mcp-aws/tab-reaper.cjs');
async function main(){
 const file=process.argv[3], mode=process.argv[2];const c=createClient('http://mcp-proxy:8931/mcp');
 try {
  await c.request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'live-view-maintenance',version:'1'}});await c.notify('notifications/initialized');
  let code;
  if(mode==='save')code=`async page => ({urls:page.context().pages().map(p=>p.url()),selected:page.context().pages().indexOf(page),cookies:await page.context().cookies()})`;
  else if(mode==='restore'){
   const saved=JSON.parse(fs.readFileSync(file));
   code=`async page => { const urls=${JSON.stringify(saved.urls)};const context=page.context();const existing=context.pages();
    for(let i=0;i<urls.length;i++){const p=existing[i]||await context.newPage(); if(p.url()!==urls[i])await p.goto(urls[i],{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{});}
    return {tabs:context.pages().length,cookies:await context.cookies()}; }`;
  } else throw new Error('Use save or restore');
  const r=await c.request('tools/call',{name:'browser_run_code_unsafe',arguments:{code}});const v=JSON.parse(extractJsonObject(r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n')));
  const hash=cookie=>crypto.createHash('sha256').update(JSON.stringify([cookie.name,cookie.value,cookie.domain,cookie.path])).digest('hex');
  if(mode==='save'){const hashes=v.cookies.map(hash);delete v.cookies;v.cookieHashes=hashes;fs.writeFileSync(file,JSON.stringify(v),{mode:0o600});console.log(JSON.stringify({savedTabs:v.urls.length,cookies:hashes.length}));}
  else{const saved=JSON.parse(fs.readFileSync(file));const found=new Set(v.cookies.map(hash));const preserved=saved.cookieHashes.filter(h=>found.has(h)).length;await c.request('tools/call',{name:'browser_tabs',arguments:{action:'select',index:saved.selected}});console.log(JSON.stringify({restoredTabs:v.tabs,previousCookies:saved.cookieHashes.length,preservedCookies:preserved}));if(preserved!==saved.cookieHashes.length)throw new Error('Cookie persistence mismatch');}
 }finally{/* Retain the shared browser session through the maintenance boundary. */}
}
main().catch(()=>{console.error('Maintenance failed; inspect private state through SSM');process.exitCode=1;});
