'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const media = fs.readFileSync(path.join(__dirname, '../fixtures/lesson-20s.webm'));
const video = (origin, lesson) => `<video controls muted playsinline src="${origin}/lesson.webm?lesson=${lesson}" width="360"></video>`;
async function server() {
  let origin;
  const instance = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === '/lesson.webm') {
      response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': media.length });
      return response.end(media);
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.pathname === '/player') return response.end(video(origin, url.searchParams.get('lesson')));
    if (url.pathname === '/card') return response.end(`<iframe width="430" height="330" src="${origin}/player?lesson=${url.searchParams.get('lesson')}"></iframe>`);
    if (url.pathname === '/manual') return response.end(`<!doctype html><meta charset="utf-8">
      <div id="lesson1" class="posCatalog_active">第一节</div><div id="lesson2">第二节</div><button id="next">下一节</button>
      <script>window.clicks=0;window.effect=false;document.querySelector('#next').onclick=()=>{window.clicks++;
      if(window.effect){document.querySelector('#lesson1').className='';document.querySelector('#lesson2').className='posCatalog_active';}};</script>`);
    const mode = url.searchParams.get('mode') || 'plain';
    const alternate = origin.replace('127.0.0.1', 'localhost');
    response.end(`<!doctype html><meta charset="utf-8"><title>${mode} course fixture</title>
      <style>span{display:inline-block;padding:12px;cursor:pointer}.currents{background:#7cc}iframe{width:500px;height:380px}</style>
      <div class="tabtags">${[1, 2, 3, 4].map(lesson => `<span id="dct${lesson}" ${lesson === 1 ? 'class="currents"' : ''}>视频任务${lesson}</span>`).join('')}</div>
      <div id="host"></div><script>
      window.lesson=1;window.changes=0;const mode=${JSON.stringify(mode)};
      function load(lesson){
        const host=document.querySelector('#host');host.replaceChildren();
        const html='<video controls muted playsinline src="${origin}/lesson.webm?lesson='+lesson+'" width="360"></video>';
        if(mode==='plain')host.innerHTML=html;
        else if(mode==='dynamic')setTimeout(()=>{host.innerHTML=html},700);
        else if(mode==='about'||mode==='srcdoc'){
          const frame=document.createElement('iframe');
          if(mode==='srcdoc')frame.srcdoc=html;
          host.append(frame);
          if(mode==='about'){frame.contentDocument.open();frame.contentDocument.write(html);frame.contentDocument.close();}
        }else{const frame=document.createElement('iframe');
          frame.src=(mode==='cross'?'${alternate}':'${origin}')+'/card?lesson='+lesson;host.append(frame);}
      }
      for(const item of document.querySelectorAll('[id^=dct]'))item.onclick=()=>{
        const lesson=Number(item.id.slice(3));if(lesson!==window.lesson+1)return;
        document.querySelector('.currents').classList.remove('currents');item.classList.add('currents');
        window.lesson=lesson;window.changes++;load(lesson);
      };load(1);</script>`);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + instance.address().port;
  return { origin, close: () => new Promise(resolve => instance.close(resolve)) };
}
module.exports = { server };
