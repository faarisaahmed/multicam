import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, onSnapshot, serverTimestamp, increment
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

/* ---------------- helpers ---------------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1
function generateCode(len = 5) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  window.scrollTo(0, 0);
}

function sessionRef(code) {
  return doc(db, 'sessions', code);
}
function camerasCol(code) {
  return collection(db, 'sessions', code, 'cameras');
}

async function sessionExists(code) {
  const snap = await getDoc(sessionRef(code));
  return snap.exists();
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* shared renderer used by both the controller album and the camera album modal */
function renderAlbum(container, clips) {
  if (clips.length === 0) {
    container.innerHTML = '<p class="empty-hint">Saved takes will show up here.</p>';
    return;
  }
  const sorted = [...clips].sort((a, b) => b.createdAt - a.createdAt);
  container.innerHTML = '';
  sorted.forEach(clip => {
    const item = document.createElement('div');
    item.className = 'album-item';
    item.innerHTML = `
      <div class="album-item-meta">
        <span class="album-item-cam">${escapeHtml(clip.cameraName || 'Camera')}</span>
        <span>${formatTime(clip.createdAt)}</span>
      </div>
      <video controls playsinline src="${clip.url}"></video>
    `;
    container.appendChild(item);
  });
}

function extFromType(type) {
  return (type && type.includes('mp4')) ? 'mp4' : 'webm';
}

function formatFileTime(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function downloadClip(clip) {
  const ext = extFromType(clip.type);
  const a = document.createElement('a');
  a.href = clip.url;
  a.download = `${(clip.cameraName || 'camera').replace(/\s+/g, '-')}-${formatFileTime(clip.createdAt)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveAllClips(clips) {
  if (clips.length === 0) { toast('No clips to save yet.'); return; }
  clips.forEach((clip, i) => setTimeout(() => downloadClip(clip), i * 450));
  toast(`Saving ${clips.length} clip${clips.length > 1 ? 's' : ''}…`);
}

/* ---------------- state ---------------- */

let pendingCode = null;   // code currently being set up in the role picker
let pendingIsNew = false; // whether we still need to create the session doc

/* ---------------- HOME ---------------- */

document.getElementById('btn-new-session').addEventListener('click', async () => {
  pendingCode = generateCode();
  pendingIsNew = true;
  document.getElementById('role-code-display').textContent = spaceOut(pendingCode);
  wireDynamicBack('home');
  showView('role');
});

document.getElementById('btn-join-session').addEventListener('click', () => {
  document.getElementById('join-code-input').value = '';
  document.getElementById('btn-join-continue').disabled = true;
  showView('join');
});

document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.back));
});

function wireDynamicBack(target) {
  const btn = document.querySelector('[data-back-dynamic]');
  btn.textContent = '←';
  btn.onclick = () => showView(target);
}

function spaceOut(code) {
  return code.split('').join(' ');
}

/* ---------------- JOIN ---------------- */

const joinInput = document.getElementById('join-code-input');
joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  document.getElementById('btn-join-continue').disabled = joinInput.value.length !== 5;
});

document.getElementById('btn-join-continue').addEventListener('click', async () => {
  const code = joinInput.value;
  const btn = document.getElementById('btn-join-continue');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const exists = await sessionExists(code);
    if (!exists) {
      toast("That code doesn't match a live session.");
      btn.textContent = originalLabel;
      btn.disabled = false;
      return;
    }
    pendingCode = code;
    pendingIsNew = false;
    document.getElementById('role-code-display').textContent = spaceOut(code);
    wireDynamicBack('join');
    btn.textContent = originalLabel;
    btn.disabled = false;
    showView('role');
  } catch (e) {
    console.error(e);
    toast('Could not reach the session. Check your connection.');
    btn.textContent = originalLabel;
    btn.disabled = false;
  }
});

/* ---------------- ROLE PICKER ---------------- */

document.getElementById('btn-role-camera').addEventListener('click', async () => {
  await ensureSessionCreated();
  startCameraRole(pendingCode);
});

document.getElementById('btn-role-controller').addEventListener('click', async () => {
  await ensureSessionCreated();
  startControllerRole(pendingCode);
});

async function ensureSessionCreated() {
  if (pendingIsNew) {
    await setDoc(sessionRef(pendingCode), { createdAt: serverTimestamp() });
    pendingIsNew = false;
  }
}

/* =========================================================
   CAMERA ROLE
   ========================================================= */

let camCode = null;
let camId = null;
let camStream = null;
let camFacing = 'environment';
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let lastHandledSeq = null;
let camDocUnsub = null;
let sessionUnsub = null;
let heartbeatTimer = null;
let camState = 'idle'; // idle | recording | reviewing
let camPeer = null;
let controllerConn = null;
let controllerReconnectTimer = null;
let camAlbumClips = [];
let pendingAutoSave = false;
let currentCall = null;

async function startCameraRole(code) {
  camCode = code;
  camId = uuid();
  camAlbumClips = [];
  document.getElementById('cam-code-chip').textContent = code;
  document.getElementById('cam-name-input').value = 'Camera';
  updateCamAlbumBadge();
  showView('camera');
  setCamStatus('connecting', 'Starting camera…');

  try {
    await openCameraStream(camFacing);
  } catch (e) {
    console.error(e);
    setCamStatus('idle', 'Camera access denied');
    toast('Allow camera access to continue.');
    return;
  }

  await setDoc(doc(db, 'sessions', code, 'cameras', camId), {
    name: document.getElementById('cam-name-input').value || 'Camera',
    status: 'idle',
    command: null,
    commandSeq: 0,
    joinedAt: serverTimestamp(),
    lastSeen: serverTimestamp()
  });
  lastHandledSeq = 0;
  camState = 'idle';
  setCamStatus('idle', 'Ready — waiting for controller');

  camDocUnsub = onSnapshot(doc(db, 'sessions', code, 'cameras', camId), snap => {
    if (!snap.exists()) return; // we deleted it ourselves on leave
    const data = snap.data();
    if (typeof data.commandSeq === 'number' && data.commandSeq !== lastHandledSeq) {
      lastHandledSeq = data.commandSeq;
      handleCommand(data.command);
    }
  });

  sessionUnsub = onSnapshot(sessionRef(code), snap => {
    if (!snap.exists()) {
      toast('The controller ended this session.');
      leaveCameraRole();
      showView('home');
    }
  });

  heartbeatTimer = setInterval(() => {
    updateDoc(doc(db, 'sessions', code, 'cameras', camId), { lastSeen: serverTimestamp() }).catch(() => {});
  }, 5000);

  setupCameraPeer();
}

async function openCameraStream(facing) {
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true
  });
  const liveEl = document.getElementById('cam-live');
  liveEl.srcObject = camStream;
}

document.getElementById('btn-flip-camera').addEventListener('click', async () => {
  if (camState !== 'idle') { toast('Finish this take before flipping.'); return; }
  camFacing = camFacing === 'environment' ? 'user' : 'environment';
  try {
    await openCameraStream(camFacing);
  } catch (e) {
    toast('Could not switch camera.');
  }
});

function setCamStatus(kind, text) {
  const dot = document.getElementById('cam-status-dot');
  dot.className = 'tally-dot';
  if (kind === 'idle') dot.classList.add('tally-green', 'pulse-soft');
  else if (kind === 'recording') dot.classList.add('tally-red', 'pulse');
  else if (kind === 'reviewing') dot.classList.add('tally-amber');
  document.getElementById('cam-status-text').textContent = text;
  document.getElementById('cam-waiting').style.display = (kind === 'idle') ? 'flex' : 'none';
}

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function handleCommand(command) {
  if (command === 'start' && camState === 'idle') {
    beginRecording();
  } else if (command === 'stop' && camState === 'recording') {
    pendingAutoSave = false;
    stopRecording();
  } else if (command === 'stop_autosave' && camState === 'recording') {
    pendingAutoSave = true;
    stopRecording();
  }
}

function beginRecording() {
  recordedChunks = [];
  const mimeType = pickMimeType();
  try {
    mediaRecorder = mimeType ? new MediaRecorder(camStream, { mimeType }) : new MediaRecorder(camStream);
  } catch (e) {
    console.error(e);
    toast('Recording is not supported in this browser.');
    return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start();
  camState = 'recording';
  setCamStatus('recording', 'Recording');
  updateDoc(doc(db, 'sessions', camCode, 'cameras', camId), { status: 'recording' }).catch(() => {});

  if (camPeer && camPeer.open) {
    try { currentCall = camPeer.call(`${camCode}-controller`, camStream); } catch (e) { currentCall = null; }
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (currentCall) {
    try { currentCall.close(); } catch (e) {}
    currentCall = null;
  }
}

function onRecordingStopped() {
  const type = mediaRecorder.mimeType || 'video/webm';
  recordedBlob = new Blob(recordedChunks, { type });

  if (pendingAutoSave) {
    pendingAutoSave = false;
    packageAndSendClip(recordedBlob);
    recordedBlob = null;
    recordedChunks = [];
    camState = 'idle';
    setCamStatus('idle', 'Switched — ready');
    updateDoc(doc(db, 'sessions', camCode, 'cameras', camId), { status: 'idle' }).catch(() => {});
    return;
  }

  camState = 'reviewing';
  setCamStatus('reviewing', 'Reviewing take');
  updateDoc(doc(db, 'sessions', camCode, 'cameras', camId), { status: 'reviewing' }).catch(() => {});

  const liveEl = document.getElementById('cam-live');
  const reviewEl = document.getElementById('cam-review');
  liveEl.style.display = 'none';
  reviewEl.style.display = 'block';
  reviewEl.src = URL.createObjectURL(recordedBlob);
  reviewEl.play().catch(() => {});
  document.getElementById('cam-review-bar').style.display = 'block';
}

document.getElementById('btn-retake').addEventListener('click', () => {
  discardReview();
  camState = 'idle';
  setCamStatus('idle', 'Ready — waiting for controller');
  updateDoc(doc(db, 'sessions', camCode, 'cameras', camId), { status: 'idle' }).catch(() => {});
});

function packageAndSendClip(blob) {
  const camName = document.getElementById('cam-name-input').value || 'Camera';
  const clip = { id: uuid(), cameraName: camName, blob, createdAt: Date.now() };
  addClipToCamAlbum(clip);
  if (controllerConn && controllerConn.open) {
    try {
      controllerConn.send({ type: 'clip', clip: { id: clip.id, cameraName: clip.cameraName, blob: clip.blob, createdAt: clip.createdAt } });
    } catch (e) {
      console.error(e);
      toast('Saved on this phone — could not reach the controller.');
    }
  } else {
    toast('Saved on this phone — controller not connected yet.');
  }
}

document.getElementById('btn-save-clip').addEventListener('click', async () => {
  packageAndSendClip(recordedBlob);
  toast('Saved to album.');
  discardReview();
  camState = 'idle';
  setCamStatus('idle', 'Saved — ready for next take');
  updateDoc(doc(db, 'sessions', camCode, 'cameras', camId), { status: 'idle' }).catch(() => {});
});

function discardReview() {
  const liveEl = document.getElementById('cam-live');
  const reviewEl = document.getElementById('cam-review');
  reviewEl.pause();
  if (reviewEl.src) URL.revokeObjectURL(reviewEl.src);
  reviewEl.removeAttribute('src');
  reviewEl.style.display = 'none';
  liveEl.style.display = 'block';
  document.getElementById('cam-review-bar').style.display = 'none';
  recordedBlob = null;
  recordedChunks = [];
}

function addClipToCamAlbum(clip) {
  const url = URL.createObjectURL(clip.blob);
  camAlbumClips.push({ id: clip.id, cameraName: clip.cameraName, url, type: clip.blob.type || 'video/webm', createdAt: clip.createdAt });
  updateCamAlbumBadge();
  renderAlbum(document.getElementById('cam-album-list'), camAlbumClips);
}

function updateCamAlbumBadge() {
  const badge = document.getElementById('cam-album-count');
  badge.textContent = camAlbumClips.length > 0 ? String(camAlbumClips.length) : '';
  badge.style.display = camAlbumClips.length > 0 ? 'flex' : 'none';
}

document.getElementById('btn-open-cam-album').addEventListener('click', () => {
  document.getElementById('cam-album-modal').classList.add('open');
});
document.getElementById('btn-close-cam-album').addEventListener('click', () => {
  document.getElementById('cam-album-modal').classList.remove('open');
});
document.getElementById('btn-save-all-cam').addEventListener('click', () => saveAllClips(camAlbumClips));

let nameDebounce = null;
document.getElementById('cam-name-input').addEventListener('input', (e) => {
  clearTimeout(nameDebounce);
  const val = e.target.value;
  nameDebounce = setTimeout(() => {
    if (!camCode || !camId) return;
    updateDoc(doc(db, 'sessions', camCode, 'cameras', camId), { name: val || 'Camera' }).catch(() => {});
  }, 600);
});

document.getElementById('btn-leave-camera').addEventListener('click', async () => {
  await leaveCameraRole();
  showView('home');
});

async function leaveCameraRole() {
  clearInterval(heartbeatTimer);
  clearInterval(controllerReconnectTimer);
  if (camDocUnsub) camDocUnsub();
  if (sessionUnsub) sessionUnsub();
  if (currentCall) { try { currentCall.close(); } catch (e) {} currentCall = null; }
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  if (camPeer) { try { camPeer.destroy(); } catch (e) {} }
  camAlbumClips.forEach(c => URL.revokeObjectURL(c.url));
  camAlbumClips = [];
  if (camCode && camId) {
    try { await deleteDoc(doc(db, 'sessions', camCode, 'cameras', camId)); } catch (e) {}
  }
  camCode = null; camId = null; camState = 'idle'; controllerConn = null;
}

/* ---- camera <-> controller peer connection ---- */

function setupCameraPeer() {
  camPeer = new Peer(`${camCode}-cam-${camId}`, { config: { iceServers: ICE_SERVERS }, debug: 0 });
  camPeer.on('open', () => tryConnectToController());
  camPeer.on('error', (err) => console.warn('peer error', err && err.type));
  controllerReconnectTimer = setInterval(() => {
    if (!controllerConn || !controllerConn.open) tryConnectToController();
  }, 4000);
}

function tryConnectToController() {
  if (!camPeer || camPeer.destroyed) return;
  if (controllerConn && controllerConn.open) return;
  try {
    const conn = camPeer.connect(`${camCode}-controller`, { reliable: true });
    conn.on('open', () => { controllerConn = conn; });
    conn.on('data', (data) => {
      if (data && data.type === 'clip') addClipToCamAlbum(data.clip);
    });
    conn.on('close', () => { if (controllerConn === conn) controllerConn = null; });
    conn.on('error', () => { if (controllerConn === conn) controllerConn = null; });
  } catch (e) { /* controller not up yet, will retry */ }
}

/* =========================================================
   CONTROLLER ROLE
   ========================================================= */

let ctrlCode = null;
let ctrlCamerasUnsub = null;
let ctrlOfflineTimer = null;
let latestCameras = [];
let ctrlPeer = null;
let camConns = new Map(); // camId -> DataConnection
let ctrlAlbumClips = [];
let ctrlMode = 'manual';
let liveStreams = new Map(); // camId -> MediaStream
let liveFeedSelection = 'all';

document.getElementById('btn-save-all-ctrl').addEventListener('click', () => saveAllClips(ctrlAlbumClips));

const MODE_HINTS = {
  manual: 'Each camera records independently — start, stop, and review takes on its own.',
  swap: 'Only one camera is live at a time. Tap another camera to cut to it instantly — the outgoing take auto-saves, no review needed.',
  group: 'One button turns every connected camera on or off together, all at once.'
};

document.getElementById('mode-select').addEventListener('change', (e) => {
  ctrlMode = e.target.value;
  document.getElementById('group-bar').style.display = ctrlMode === 'group' ? 'block' : 'none';
  document.getElementById('mode-hint').textContent = MODE_HINTS[ctrlMode];
  renderCameraGrid();
});

document.querySelectorAll('.page-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.ctrl-page').forEach(p => p.classList.toggle('active', p.dataset.page === tab.dataset.page));
  });
});

function startControllerRole(code) {
  ctrlCode = code;
  ctrlAlbumClips = [];
  ctrlMode = 'manual';
  liveStreams = new Map();
  liveFeedSelection = 'all';
  document.getElementById('mode-select').value = 'manual';
  document.getElementById('group-bar').style.display = 'none';
  document.getElementById('mode-hint').textContent = MODE_HINTS.manual;
  document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('active', t.dataset.page === 'recording'));
  document.querySelectorAll('.ctrl-page').forEach(p => p.classList.toggle('active', p.dataset.page === 'recording'));
  document.getElementById('ctrl-code-display').textContent = spaceOut(code);
  showView('controller');
  renderAlbum(document.getElementById('album-list'), ctrlAlbumClips);
  renderLiveFeed();

  ctrlCamerasUnsub = onSnapshot(camerasCol(code), snap => {
    latestCameras = [];
    snap.forEach(d => latestCameras.push({ id: d.id, ...d.data() }));
    latestCameras.sort((a, b) => (a.joinedAt?.toMillis?.() || 0) - (b.joinedAt?.toMillis?.() || 0));
    renderCameraGrid();
  });

  ctrlOfflineTimer = setInterval(renderCameraGrid, 5000);

  setupControllerPeer(code);
}

function setupControllerPeer(code) {
  ctrlPeer = new Peer(`${code}-controller`, { config: { iceServers: ICE_SERVERS }, debug: 0 });
  ctrlPeer.on('error', (err) => console.warn('peer error', err && err.type));
  ctrlPeer.on('connection', conn => {
    conn.on('open', () => {
      const camId = conn.peer.replace(`${code}-cam-`, '');
      camConns.set(camId, conn);
      ctrlAlbumClips.forEach(clip => {
        try { conn.send({ type: 'clip', clip: { id: clip.id, cameraName: clip.cameraName, blob: clip.blob, createdAt: clip.createdAt } }); } catch (e) {}
      });
    });
    conn.on('data', (data) => {
      if (data && data.type === 'clip') {
        addClipToCtrlAlbum(data.clip);
        for (const [id, other] of camConns) {
          if (other !== conn && other.open) {
            try { other.send(data); } catch (e) {}
          }
        }
      }
    });
    conn.on('close', () => {
      for (const [id, c] of camConns) if (c === conn) camConns.delete(id);
    });
  });
  ctrlPeer.on('call', call => {
    const camId = call.peer.replace(`${code}-cam-`, '');
    call.answer();
    call.on('stream', (remoteStream) => {
      liveStreams.set(camId, remoteStream);
      renderLiveFeed();
    });
    call.on('close', () => {
      liveStreams.delete(camId);
      renderLiveFeed();
    });
  });
}

function addClipToCtrlAlbum(clip) {
  const url = URL.createObjectURL(clip.blob);
  ctrlAlbumClips.push({ id: clip.id, cameraName: clip.cameraName, blob: clip.blob, url, createdAt: clip.createdAt });
  renderAlbum(document.getElementById('album-list'), ctrlAlbumClips);
}

function buildLiveVideoEl(cam) {
  const wrap = document.createElement('div');
  wrap.className = 'live-feed-item';
  const label = document.createElement('div');
  label.className = 'live-feed-label';
  label.innerHTML = `<span class="tally-dot tally-red pulse"></span>${escapeHtml(cam.name || 'Camera')}`;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  wrap.appendChild(label);
  wrap.appendChild(video);
  return { wrap, video };
}

function renderLiveFeed() {
  const container = document.getElementById('live-feed-container');
  const dropdownWrap = document.getElementById('live-feed-dropdown-wrap');
  const select = document.getElementById('live-feed-select');
  const now = Date.now();
  const recordingCams = latestCameras.filter(c => c.status === 'recording' && !isCamOffline(c, now) && liveStreams.has(c.id));

  if (recordingCams.length === 0) {
    dropdownWrap.style.display = 'none';
    container.className = 'live-feed-container';
    container.innerHTML = '<p class="empty-hint">No camera currently recording.</p>';
    liveFeedSelection = 'all';
    return;
  }

  if (recordingCams.length === 1) {
    dropdownWrap.style.display = 'none';
    container.className = 'live-feed-container';
    container.innerHTML = '';
    const { wrap, video } = buildLiveVideoEl(recordingCams[0]);
    container.appendChild(wrap);
    video.srcObject = liveStreams.get(recordingCams[0].id);
    return;
  }

  dropdownWrap.style.display = 'block';
  select.innerHTML = '<option value="all">All cameras</option>' +
    recordingCams.map(c => `<option value="${c.id}">${escapeHtml(c.name || 'Camera')}</option>`).join('');
  const validValues = ['all', ...recordingCams.map(c => c.id)];
  liveFeedSelection = validValues.includes(liveFeedSelection) ? liveFeedSelection : 'all';
  select.value = liveFeedSelection;

  container.innerHTML = '';
  if (liveFeedSelection === 'all') {
    container.className = 'live-feed-container live-feed-grid';
    recordingCams.forEach(cam => {
      const { wrap, video } = buildLiveVideoEl(cam);
      container.appendChild(wrap);
      video.srcObject = liveStreams.get(cam.id);
    });
  } else {
    container.className = 'live-feed-container';
    const cam = recordingCams.find(c => c.id === liveFeedSelection);
    if (cam) {
      const { wrap, video } = buildLiveVideoEl(cam);
      container.appendChild(wrap);
      video.srcObject = liveStreams.get(cam.id);
    }
  }
}

document.getElementById('live-feed-select').addEventListener('change', (e) => {
  liveFeedSelection = e.target.value;
  renderLiveFeed();
});

function isCamOffline(cam, now) {
  const lastSeenMs = cam.lastSeen?.toMillis?.() ?? now;
  return (now - lastSeenMs) > 15000;
}

function renderCameraGrid() {
  const grid = document.getElementById('camera-grid');
  renderLiveFeed();
  if (latestCameras.length === 0) {
    grid.innerHTML = '<p class="empty-hint">No cameras connected yet. Share the code above.</p>';
    if (ctrlMode === 'group') updateGroupBar();
    return;
  }
  grid.innerHTML = '';
  const now = Date.now();
  latestCameras.forEach(cam => {
    const isOffline = isCamOffline(cam, now);
    const isLiveInSwap = ctrlMode === 'swap' && cam.status === 'recording';

    const card = document.createElement('div');
    card.className = 'camera-card' + (isOffline ? ' is-offline' : '') + (isLiveInSwap ? ' is-live' : '');

    const dotClass = isOffline ? '' : (cam.status === 'recording' ? 'tally-red pulse' : cam.status === 'reviewing' ? 'tally-amber' : 'tally-green');
    const statusText = isOffline ? 'Offline' : (cam.status === 'recording' ? (ctrlMode === 'swap' ? 'Live' : 'Recording') : cam.status === 'reviewing' ? 'Reviewing' : 'Ready');

    const top = document.createElement('div');
    top.className = 'camera-card-top';
    top.innerHTML = `<span class="tally-dot ${dotClass}"></span><span class="camera-card-name">${escapeHtml(cam.name || 'Camera')}</span>`;

    const status = document.createElement('div');
    status.className = 'camera-card-status';
    status.textContent = statusText;

    const btn = document.createElement('button');

    if (ctrlMode === 'swap') {
      btn.disabled = isOffline || cam.status === 'reviewing';
      if (cam.status === 'recording') {
        btn.className = 'rec-btn rec-btn-stop';
        btn.innerHTML = '<span class="rec-dot"></span> End';
        btn.onclick = () => sendCommand(cam.id, 'stop');
      } else if (cam.status === 'reviewing') {
        btn.className = 'rec-btn rec-btn-wait';
        btn.textContent = 'Saving…';
      } else {
        btn.className = 'rec-btn rec-btn-start';
        btn.textContent = 'Cut to this camera';
        btn.onclick = () => swapTo(cam.id);
      }
    } else if (ctrlMode === 'group') {
      btn.className = 'rec-btn rec-btn-wait';
      btn.disabled = true;
      btn.textContent = isOffline ? 'Offline' : (cam.status === 'recording' ? 'Recording' : cam.status === 'reviewing' ? 'Saving…' : 'Ready');
    } else { // manual
      btn.disabled = isOffline || cam.status === 'reviewing';
      if (cam.status === 'recording') {
        btn.className = 'rec-btn rec-btn-stop';
        btn.innerHTML = '<span class="rec-dot"></span> Stop';
        btn.onclick = () => sendCommand(cam.id, 'stop');
      } else if (cam.status === 'reviewing') {
        btn.className = 'rec-btn rec-btn-wait';
        btn.textContent = 'Reviewing…';
      } else {
        btn.className = 'rec-btn rec-btn-start';
        btn.innerHTML = '<span class="rec-dot"></span> Record';
        btn.onclick = () => sendCommand(cam.id, 'start');
      }
    }

    card.appendChild(top);
    card.appendChild(status);
    card.appendChild(btn);
    grid.appendChild(card);
  });

  if (ctrlMode === 'group') updateGroupBar();
}

async function swapTo(camId) {
  const live = latestCameras.find(c => c.status === 'recording');
  const tasks = [];
  if (live && live.id !== camId) tasks.push(sendCommand(live.id, 'stop_autosave'));
  tasks.push(sendCommand(camId, 'start'));
  try { await Promise.all(tasks); } catch (e) {}
}

function updateGroupBar() {
  const btn = document.getElementById('btn-group-toggle');
  const now = Date.now();
  const anyRecording = latestCameras.some(c => c.status === 'recording');
  if (anyRecording) {
    btn.textContent = 'Turn off all';
    btn.onclick = () => {
      latestCameras.filter(c => c.status === 'recording').forEach(c => sendCommand(c.id, 'stop_autosave'));
    };
  } else {
    btn.textContent = 'Turn on all';
    btn.onclick = () => {
      latestCameras.filter(c => c.status === 'idle' && !isCamOffline(c, now)).forEach(c => sendCommand(c.id, 'start'));
    };
  }
}

async function sendCommand(cameraId, command) {
  try {
    await updateDoc(doc(db, 'sessions', ctrlCode, 'cameras', cameraId), {
      command,
      commandSeq: increment(1)
    });
  } catch (e) {
    console.error(e);
    toast('Could not reach that camera.');
  }
}

document.getElementById('btn-leave-controller').addEventListener('click', async () => {
  await leaveControllerRole();
  showView('home');
});

async function leaveControllerRole() {
  if (ctrlCamerasUnsub) ctrlCamerasUnsub();
  clearInterval(ctrlOfflineTimer);
  for (const cam of latestCameras) {
    try { await deleteDoc(doc(db, 'sessions', ctrlCode, 'cameras', cam.id)); } catch (e) {}
  }
  if (ctrlCode) {
    try { await deleteDoc(sessionRef(ctrlCode)); } catch (e) {}
  }
  if (ctrlPeer) { try { ctrlPeer.destroy(); } catch (e) {} }
  camConns.clear();
  liveStreams.clear();
  ctrlAlbumClips.forEach(c => URL.revokeObjectURL(c.url));
  ctrlAlbumClips = [];
  ctrlCode = null;
  latestCameras = [];
}

/* ---------------- lifecycle ---------------- */

window.addEventListener('beforeunload', () => {
  if (camCode && camId) {
    try { deleteDoc(doc(db, 'sessions', camCode, 'cameras', camId)); } catch (e) {}
  }
});
