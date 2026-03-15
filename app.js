/**
 * app.js (module)
 * - Uses a Web Worker (worker.js) to run heavy parallel streams and calculations.
 * - Handles server selection, history, charts, and UI.
 */

const SERVER_LIST = [
  // Example servers. In production, populate dynamically (geo-located).
  { id: 'local', name: 'Local (this server)', base: '' },
  { id: 'region-eu', name: 'Europe (example)', base: 'https://eu.example.com' },
  { id: 'region-us', name: 'US (example)', base: 'https://us.example.com' }
];

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const serverSelect = document.getElementById('serverSelect');
const pingEl = document.getElementById('ping');
const jitterEl = document.getElementById('jitter');
const dlEl = document.getElementById('download');
const dlInfo = document.getElementById('dlInfo');
const ulEl = document.getElementById('upload');
const ulInfo = document.getElementById('ulInfo');
const progressBar = document.getElementById('progressBar');
const logEl = document.getElementById('log');
const historyEl = document.getElementById('history');
const serverUrlEl = document.getElementById('serverUrl');
const configSummary = document.getElementById('configSummary');

let worker = null;
let chart = null;
let history = JSON.parse(localStorage.getItem('speed_history') || '[]');

function populateServers(){
  SERVER_LIST.forEach(s=>{
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    serverSelect.appendChild(opt);
  });
  serverSelect.value = 'local';
  updateServerUrl();
}
function updateServerUrl(){
  const s = SERVER_LIST.find(x=>x.id===serverSelect.value);
  serverUrlEl.textContent = s ? (s.base || window.location.origin) : '';
}
serverSelect.addEventListener('change', updateServerUrl);

function log(msg){
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `${time} — ${msg}\n` + logEl.textContent;
}

/* Chart setup */
function initChart(){
  const ctx = document.getElementById('throughputChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Download Mbps', data: [], borderColor: '#0b84ff', tension: 0.2 },
        { label: 'Upload Mbps', data: [], borderColor: '#00d4ff', tension: 0.2 }
      ]
    },
    options: { responsive:true, maintainAspectRatio:false, scales:{y:{beginAtZero:true}} }
  });
}

/* Render history */
function renderHistory(){
  historyEl.innerHTML = '<strong>History</strong>';
  if(history.length===0){ historyEl.innerHTML += '<div>No previous tests</div>'; return; }
  history.slice().reverse().forEach(h=>{
    const d = new Date(h.ts).toLocaleString();
    const div = document.createElement('div');
    div.innerHTML = `${d} — DL: <strong>${h.download} Mbps</strong> · UL: <strong>${h.upload} Mbps</strong> · Ping: ${h.ping} ms · <a href="${h.share}" target="_blank" rel="noopener">share</a>`;
    historyEl.appendChild(div);
  });
}

/* Save history and create shareable link (simple encoded state) */
function saveHistory(result){
  const id = crypto.randomUUID();
  const entry = { id, ts: Date.now(), ...result, share: `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(btoa(JSON.stringify(result)))}` };
  history.push(entry);
  localStorage.setItem('speed_history', JSON.stringify(history));
  renderHistory();
}

/* Start test: spawn worker */
startBtn.addEventListener('click', async ()=>{
  if(worker) return;
  const server = SERVER_LIST.find(s=>s.id===serverSelect.value);
  const base = server ? (server.base || '') : '';
  updateServerUrl();
  // config: parallel streams, durations, chunk sizes
  const config = {
    base,
    pingProbes: 8,
    download: { duration: 8, parallel: 4, sizesMB: [4,8,16] }, // vary sizes to detect slow start
    upload: { duration: 8, parallel: 4, chunkKB: [128,256,512] },
    jitterWindow: 5
  };
  configSummary.textContent = `parallel=${config.download.parallel}; duration=${config.download.duration}s`;
  progressBar.style.width = '2%';
  pingEl.textContent = 'Testing...';
  dlEl.textContent = 'Testing...';
  ulEl.textContent = 'Testing...';
  logEl.textContent = '';
  // create worker
  worker = new Worker('worker.js', { type: 'module' });
  worker.postMessage({ type: 'start', config });
  startBtn.disabled = true;
  stopBtn.disabled = false;
  worker.onmessage = (ev)=>{
    const msg = ev.data;
    if(msg.type === 'log') log(msg.text);
    if(msg.type === 'progress') progressBar.style.width = `${msg.pct}%`;
    if(msg.type === 'pingResult'){
      pingEl.textContent = `${msg.ping} ms`;
      jitterEl.textContent = `Jitter: ${msg.jitter} ms · Packet loss: ${msg.packetLoss}%`;
    }
    if(msg.type === 'downloadResult'){
      dlEl.textContent = `${msg.mbps.toFixed(2)} Mbps`;
      dlInfo.textContent = `Parallel streams: ${msg.parallel} · files: ${msg.files}`;
      // update chart
      chart.data.labels.push(new Date().toLocaleTimeString());
      chart.data.datasets[0].data.push(msg.mbps.toFixed(2));
      chart.update();
    }
    if(msg.type === 'uploadResult'){
      ulEl.textContent = `${msg.mbps.toFixed(2)} Mbps`;
      ulInfo.textContent = `Parallel streams: ${msg.parallel} · chunks: ${msg.chunks}`;
      chart.data.datasets[1].data.push(msg.mbps.toFixed(2));
      chart.update();
    }
    if(msg.type === 'complete'){
      log('Test complete');
      saveHistory({ ping: msg.ping, jitter: msg.jitter, download: msg.download, upload: msg.upload });
      worker.terminate(); worker = null;
      startBtn.disabled = false; stopBtn.disabled = true;
      progressBar.style.width = '100%';
    }
    if(msg.type === 'error'){
      log('Error: ' + msg.error);
      worker.terminate(); worker = null;
      startBtn.disabled = false; stopBtn.disabled = true;
      progressBar.style.width = '0%';
    }
  };
});

/* Stop test */
stopBtn.addEventListener('click', ()=>{
  if(worker) { worker.postMessage({ type: 'stop' }); log('Stop requested'); }
});

/* On load */
populateServers();
initChart();
renderHistory();

/* If share param present, decode and show */
(function handleShare(){
  const params = new URLSearchParams(location.search);
  if(params.has('share')){
    try{
      const obj = JSON.parse(atob(params.get('share')));
      alert(`Shared result\nDownload: ${obj.download} Mbps\nUpload: ${obj.upload} Mbps\nPing: ${obj.ping} ms`);
    }catch(e){}
  }
})();
