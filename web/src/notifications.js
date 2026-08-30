// Tab-open signals for handoffs: a chime, a red dot on the favicon, and a
// count prefix on the browser tab. Everything degrades quietly if the browser
// or the user says no — the console still works, they just miss the nudge.

const originalTitle = typeof document !== 'undefined' ? document.title : '';
let currentBadge = 0;
let faviconImg = null;
if (typeof Image !== 'undefined') {
  faviconImg = new Image();
  faviconImg.src = '/theTwoCubes.png';
}

// Web Audio ping, generated so we do not need to ship an mp3. Short two-tone
// beep, tuned so it reads as an alert without being annoying.
let audioCtx = null;
export function playChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const notes = [
      { freq: 880, at: 0,    dur: 0.14 },
      { freq: 1320, at: 0.12, dur: 0.22 },
    ];
    for (const n of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0.0001, now + n.at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + n.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + n.at);
      osc.stop(now + n.at + n.dur + 0.05);
    }
  } catch { /* audio blocked, nothing to do */ }
}

// Draws the current favicon plus a red dot in the corner, sized so the count
// stays legible in a 16 px tab. Falls back to leaving the favicon alone if the
// canvas step fails for any reason.
export function setFaviconBadge(count) {
  currentBadge = count;
  try {
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }

    if (count === 0) {
      link.href = '/theTwoCubes.png';
      return;
    }

    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      ctx.clearRect(0, 0, size, size);
      if (faviconImg && faviconImg.complete) {
        ctx.drawImage(faviconImg, 0, 0, size, size);
      } else {
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 34px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('W', size / 2, size / 2 + 2);
      }
      
      const r = 18;
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(size - r + 2, r - 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(count > 9 ? '9+' : String(count), size - r + 2, r - 1);
      
      link.href = canvas.toDataURL('image/png');
    };

    if (faviconImg && !faviconImg.complete) {
      faviconImg.onload = draw;
      faviconImg.onerror = draw;
    } else {
      draw();
    }
  } catch { /* keep the existing favicon */ }
}

export function setTitleBadge(count) {
  if (typeof document === 'undefined') return;
  document.title = count > 0 ? `(${count > 9 ? '9+' : count}) ${originalTitle}` : originalTitle;
}

// Applies the count to both the title and the favicon. Idempotent, so calling
// with the same number twice does nothing extra.
export function applyBadge(count) {
  if (count === currentBadge) return;
  setFaviconBadge(count);
  setTitleBadge(count);
}

// Tells the active service worker which chat is open right now so it can
// suppress an OS notification for a message the agent is actively reading.
// Pass null when leaving the thread. Also re-post on visibility change so
// backgrounding the tab counts as "not viewing".
let currentViewing = null;
export function setViewingConversation(id) {
  currentViewing = id != null ? String(id) : null;
  postViewing();
}

function postViewing() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  sw.ready.then((reg) => {
    const target = sw.controller || reg.active;
    if (!target) return;
    // If the tab is not visible, tell the SW nothing is open on this device
    // so an incoming push still lands in the notification tray.
    const idForSw = document.visibilityState === 'visible' ? currentViewing : null;
    target.postMessage({ type: 'VIEWING_CONVERSATION', id: idForSw });
  }).catch(() => { /* SW not ready yet, will re-post on next change */ });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', postViewing);
}
