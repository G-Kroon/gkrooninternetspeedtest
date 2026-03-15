/**
 * worker.js (module)
 * - Runs in a Web Worker to perform parallel download/upload streams and ping probes.
 * - Reports progress and results back to main thread.
 *
 * Note: fetch in workers uses same-origin rules. For cross-origin servers ensure CORS and credentials are configured.
 */

let running = false;
let controller = null;

function postLog(text){ postMessage({ type:'log', text }); }
function postProgress(pct){ postMessage({ type:'progress', pct }); }

self.onmessage = async (ev) => {
  const msg = ev.data;
  if(msg.type === 'start') {
    if(running) return;
    running = true;
    controller = new AbortController();
    try{
      const cfg = msg.config;
      postLog('Worker started');
      // 1) Ping probes across multiple server endpoints (if base empty use same origin)
      const pingRes = await measurePing(cfg.base || '', cfg.pingProbes || 6, controller.signal);
      postMessage({ type:'pingResult', ping: pingRes.avg, jitter: pingRes.jitter, packetLoss: pingRes.packetLoss });
      postProgress(10);

      // 2) Download: parallel streams, varying sizes
      const dlRes = await measureDownload(cfg.base || '', cfg.download, controller.signal);
      postMessage({ type:'downloadResult', mbps: dlRes.mbps, parallel: dlRes.parallel, files: dlRes.files });
      postProgress(60);

      // 3) Upload: parallel POSTs of random chunks
      const ulRes = await measureUpload(cfg.base || '', cfg.upload, controller.signal);
      postMessage({ type:'uploadResult', mbps: ulRes.mbps, parallel: ulRes.parallel, chunks: ulRes.chunks });
      postProgress(95);

      postMessage({ type:'complete', ping: pingRes.avg, jitter: pingRes.jitter, download: dlRes.mbps, upload: ulRes.mbps });
    }catch(err){
      if(err.name === 'AbortError') postMessage({ type:'error', error: 'aborted' });
      else postMessage({ type:'error', error: err.message || err.toString() });
    } finally {
      running = false;
      controller = null;
    }
  } else if(msg.type === 'stop'){
    if(controller) controller.abort();
    running = false;
    postLog('Worker stop requested');
  }
};

/* Helper: ping probes */
async function measurePing(base, tries, signal){
  const url = (base || '') + '/ping';
  const times = [];
  let lost = 0;
  for(let i=0;i<tries;i++){
    const t0 = performance.now();
    try{
      const res = await fetch(url + '?r=' + Math.random(), { cache:'no-store', signal });
      if(!res.ok) { lost++; continue; }
      const t1 = performance.now();
      times.push(t1 - t0);
    }catch(e){
      lost++;
    }
    await sleep(80);
  }
  if(times.length === 0) return { avg: 9999, jitter: 0, packetLoss: Math.round((lost/tries)*100) };
  // jitter: average absolute difference between successive pings
  let diffs = [];
  for(let i=1;i<times.length;i++) diffs.push(Math.abs(times[i]-times[i-1]));
  const jitter = Math.round(diffs.reduce((a,b)=>a+b,0)/diffs.length || 0);
  // discard extremes
  times.sort((a,b)=>a-b);
  if(times.length>2) times.shift(), times.pop();
  const avg = Math.round(times.reduce((a,b)=>a+b,0)/times.length);
  return { avg, jitter, packetLoss: Math.round((lost/tries)*100) };
}

/* Helper: download with parallel streams and varying sizes */
async function measureDownload(base, cfg, signal){
  const duration = cfg.duration || 6;
  const parallel = cfg.parallel || 4;
  const sizes = cfg.sizesMB || [4,8,16];
  const start = performance.now();
  let bytes = 0;
  let files = 0;
  // run parallel fetch loops
  const workers = [];
  for(let p=0;p<parallel;p++){
    workers.push((async ()=>{
      let idx = 0;
      while((performance.now()-start)/1000 < duration){
        const sizeMB = sizes[idx % sizes.length];
        const url = (base || '') + `/download?size=${sizeMB}&r=${Math.random()}`;
        try{
          const res = await fetch(url, { cache:'no-store', signal });
          const blob = await res.blob();
          bytes += blob.size;
          files++;
        }catch(e){
          // ignore individual errors but log
        }
        idx++;
      }
    })());
  }
  // progress updater
  const progressInterval = setInterval(()=>{
    const elapsed = (performance.now()-start)/1000;
    const pct = 10 + Math.min(50, Math.round((elapsed/duration)*50));
    postProgress(pct);
  }, 300);
  await Promise.all(workers);
  clearInterval(progressInterval);
  const elapsed = Math.max(0.001, (performance.now()-start)/1000);
  const mbps = (bytes * 8) / (elapsed * 1e6);
  return { mbps, bytes, files, parallel };
}

/* Helper: upload with parallel POSTs */
async function measureUpload(base, cfg, signal){
  const duration = cfg.duration || 6;
  const parallel = cfg.parallel || 4;
  const chunkKBs = cfg.chunkKB || [128,256,512];
  const start = performance.now();
  let bytes = 0;
  let chunks = 0;
  // create random buffers for each chunk size to avoid compression
  const buffers = chunkKBs.map(kb=>{
    const arr = new Uint8Array(kb*1024);
    crypto.getRandomValues(arr);
    return arr;
  });
  const workers = [];
  for(let p=0;p<parallel;p++){
    workers.push((async ()=>{
      let idx = 0;
      while((performance.now()-start)/1000 < duration){
        const buf = buffers[idx % buffers.length];
        try{
          await fetch((base || '') + '/upload?r=' + Math.random(), {
            method: 'POST',
            body: buf,
            signal,
            cache: 'no-store'
          });
          bytes += buf.byteLength;
          chunks++;
        }catch(e){
          // ignore
        }
        idx++;
      }
    })());
  }
  // progress updater
  const progressInterval = setInterval(()=>{
    const elapsed = (performance.now()-start)/1000;
    const pct = 60 + Math.min(35, Math.round((elapsed/duration)*35));
    postProgress(pct);
  }, 300);
  await Promise.all(workers);
  clearInterval(progressInterval);
  const elapsed = Math.max(0.001, (performance.now()-start)/1000);
  const mbps = (bytes * 8) / (elapsed * 1e6);
  return { mbps, bytes, chunks, parallel };
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
