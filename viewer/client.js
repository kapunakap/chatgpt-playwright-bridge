'use strict';
const canvas=document.querySelector('#screen'),ctx=canvas.getContext('2d'),address=document.querySelector('#address'),status=document.querySelector('#status'),control=document.querySelector('#control'),nav=document.querySelector('#tabs');
const token=location.hash.slice(1)||sessionStorage.getItem('live-view-token');if(location.hash)sessionStorage.setItem('live-view-token',token);history.replaceState(null,'',location.pathname);let enabled=false,ws,frameBusy=false,tabSignature="",viewportWidth=1280,viewportHeight=720;
function send(m){if(ws?.readyState===1)ws.send(JSON.stringify(m));}
function connect(){
  if(!token){status.textContent='Open using scripts/open-live-view.sh to authorize access';return;}
  ws=new WebSocket(`ws://${location.host}/ws`,['live-view',token]);
  ws.onmessage=event=>{
    const m=JSON.parse(event.data);
    if(m.type==='frame'&&!frameBusy){viewportWidth=m.metadata.deviceWidth;viewportHeight=m.metadata.deviceHeight;frameBusy=true;const img=new Image();img.onload=()=>{canvas.width=img.width;canvas.height=img.height;ctx.drawImage(img,0,0);frameBusy=false;};img.onerror=()=>{frameBusy=false;};img.src=`data:image/jpeg;base64,${m.data}`;}
    if(m.type==='status')status.textContent=m.message;
    if(m.type==='control'){enabled=m.enabled;control.checked=enabled;status.textContent=enabled?'Connected — you have control':'Connected — read-only';document.querySelectorAll('.tab-close,.browser-control').forEach(b=>{b.disabled=!enabled;});canvas.focus();}
    if(m.type==='state'){const current=m.tabs.find(t=>t.current);if(current&&document.activeElement!==address)address.value=current.url;status.textContent=enabled?'Connected — you have control':m.controller?'Connected — another viewer controls':'Connected — read-only';const signature=JSON.stringify(m.tabs);if(signature!==tabSignature){tabSignature=signature;nav.replaceChildren(...m.tabs.map(t=>{
      const group=document.createElement('span');group.className='tab-group';
      const b=document.createElement('button');b.textContent=t.title||t.url||'Blank tab';b.title=t.url;b.className='tab-select'+(t.current?' active':'');
      b.onclick=()=>{if(enabled)send({type:'tab',id:t.id});else status.textContent='Enable control to switch tabs';};
      const close=document.createElement('button');close.className='tab-close';close.dataset.targetId=t.id;close.textContent='×';close.title='Close tab';close.setAttribute('aria-label','Close tab: '+(t.title||t.url||'Blank tab'));close.disabled=!enabled;
      close.onclick=()=>{if(enabled)send({type:'close-tab',id:t.id});};
      group.append(b,close);return group;
    }));}}
  };
  ws.onclose=e=>{enabled=false;control.checked=false;status.textContent=e.code===1008?'Access expired — run the launcher again':'Disconnected — reconnecting';if(e.code!==1008)setTimeout(connect,2000);};
  ws.onerror=()=>{status.textContent='Access denied or connection unavailable — run the launcher again';};
}
control.onchange=()=>send({type:'control',enabled:control.checked});
function point(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*viewportWidth/r.width,y:(e.clientY-r.top)*viewportHeight/r.height};}
function modifiers(e){return(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);}
let moved=0;
for(const [dom,event] of [['pointermove','mouseMoved'],['pointerdown','mousePressed'],['pointerup','mouseReleased']])canvas.addEventListener(dom,e=>{if(!enabled)return;e.preventDefault();if(dom==='pointermove'&&Date.now()-moved<25)return;moved=Date.now();if(dom==='pointerdown'){canvas.focus();canvas.setPointerCapture(e.pointerId);}send({type:'mouse',event,...point(e),button:dom==='pointermove'?'none':['left','middle','right'][e.button]||'none',buttons:e.buttons,clickCount:Math.min(e.detail||1,3),modifiers:modifiers(e)});});
canvas.oncontextmenu=e=>e.preventDefault();
canvas.addEventListener('wheel',e=>{if(!enabled)return;e.preventDefault();const scale=e.deltaMode===1?16:e.deltaMode===2?canvas.height:1;send({type:'wheel',...point(e),dx:e.deltaX*scale,dy:e.deltaY*scale});},{passive:false});
for(const [dom,event] of [['keydown','keyDown'],['keyup','keyUp']])canvas.addEventListener(dom,e=>{if(!enabled||e.isComposing)return;e.preventDefault();if(dom==='keydown'&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='v'){paste();return;}if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){if(dom==='keydown')send({type:'text',text:e.key});return;}send({type:'key',event,key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e)});});
canvas.addEventListener('compositionend',e=>{if(enabled)send({type:'text',text:e.data});});
async function paste(){if(!enabled)return;let text;try{text=await navigator.clipboard.readText();}catch{text=prompt('Text to type into the browser:');}if(text)send({type:'text',text});canvas.focus();}
document.querySelector('#paste').onclick=paste;
document.querySelector('#navigation').onsubmit=e=>{e.preventDefault();if(!enabled){status.textContent='Enable control to open URLs';return;}send({type:'navigate',url:address.value});canvas.focus();};
document.querySelector('#new-tab').onclick=()=>{if(enabled)send({type:'new-tab'});};
document.querySelector('#reload').onclick=()=>{if(enabled)send({type:'reload'});};
for(const direction of ['back','forward'])document.querySelector('#'+direction).onclick=()=>{if(enabled)send({type:'history',direction});};
connect();
