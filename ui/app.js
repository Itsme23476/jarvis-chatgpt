/* JARVIS · Codex memory HUD — front end.
   Talks to the local Python server over NDJSON. The brain is your `codex` CLI,
   using your saved ChatGPT login and its plan usage limits. */
'use strict';

var $ = function (s) { return document.querySelector(s); };
var TOKEN = document.querySelector('meta[name=jarvis-token]').content;
var headers = function (extra) {
  return Object.assign({ 'X-Jarvis-Token': TOKEN }, extra || {});
};
var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var now = function () { return new Date().toTimeString().slice(0, 8); };

var graph = null, hiddenTypes = new Set(), running = false, activeCtl = null, speechCtl = null;
var answerText = '', answerBubble = null, GRAPH = { nodes: [], links: [], hubs: [], counts: [] };

/* ── action log ───────────────────────────── */
function log(kind, label, msg) {
  var e = document.createElement('div');
  e.className = 'entry k-' + kind;
  e.innerHTML = '<div class="top"><span class="ts">' + now() + '</span>'
    + '<span class="kind">' + esc(label) + '</span></div>'
    + (msg ? '<div class="msg">' + esc(msg) + '</div>' : '');
  var box = $('#log');
  box.insertBefore(e, box.firstChild);
  while (box.children.length > 45) box.removeChild(box.lastChild);
}

/* Fish Audio reads [square brackets] as stage directions, never as words. We
   send the text through untouched so the model performs them, but on screen we
   render each tag as a chip so you can see the direction and hear the result.
   The browser speechSynthesis fallback has no such notion, so it gets a
   stripped copy — otherwise it literally reads "dry" out loud. */
var TONE_RE = /\[([^\][]{1,90})\]|<\/?(?:whisper|emphasis|soft|fast|slow|stress|forceful)>/g;
function stripTones(text) {
  return String(text || '').replace(TONE_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

function lastTone(text) {
  var found = null, m;
  TONE_RE.lastIndex = 0;
  while ((m = TONE_RE.exec(text)) !== null) found = m[1] || m[0];
  return found;
}

function renderSpoken(el, text) {
  var html = '', last = 0, m;
  TONE_RE.lastIndex = 0;
  while ((m = TONE_RE.exec(text)) !== null) {
    html += esc(text.slice(last, m.index));
    html += '<span class="tone">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  html += esc(text.slice(last));
  el.innerHTML = html;
}

function bubble(who, text) {
  var b = document.createElement('div');
  b.className = 'bubble ' + who;
  if (who === 'jarvis') renderSpoken(b, text); else b.textContent = text;
  document.body.classList.add('hasconvo');
  $('#transcript').appendChild(b);
  var turns = $('#transcript').querySelectorAll('.bubble.me').length;
  $('#convoCount').textContent = turns + (turns === 1 ? ' turn' : ' turns');
  $('#transcript').scrollTop = $('#transcript').scrollHeight;
  return b;
}

function setVoiceState(state, cls) {
  $('#voiceState').textContent = state;
  $('#voiceDot').className = 'dot ' + (cls || '');
}

/* ── panels ───────────────────────────────── */
function renderHubs() {
  $('#hubs').innerHTML = GRAPH.hubs.map(function (h) {
    return '<li data-id="' + esc(h.id) + '">'
      + '<i class="swatch" style="background:' + esc(h.colour) + '"></i>'
      + '<span class="nm">' + esc(h.title) + '</span>'
      + '<span class="ct">' + h.degree + '</span></li>';
  }).join('');
  Array.prototype.forEach.call($('#hubs').children, function (li) {
    li.onclick = function () { focusNode(li.dataset.id); };
  });
}

function renderFilter() {
  var colours = {};
  GRAPH.nodes.forEach(function (n) { colours[n.type] = n.colour; });
  $('#filter').innerHTML = GRAPH.counts.map(function (pair) {
    var t = pair[0], c = pair[1];
    return '<li data-type="' + esc(t) + '" class="' + (hiddenTypes.has(t) ? 'off' : '') + '">'
      + '<i class="swatch" style="background:' + esc(colours[t] || '#8fa3bf') + '"></i>'
      + '<span class="nm">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</span>'
      + '<span class="ct">' + c + '</span></li>';
  }).join('');
  Array.prototype.forEach.call($('#filter').children, function (li) {
    li.onclick = function () {
      var t = li.dataset.type;
      if (hiddenTypes.has(t)) hiddenTypes.delete(t); else hiddenTypes.add(t);
      graph.setFilter(hiddenTypes);
      renderFilter();
    };
  });
}

function renderInspector(node, trace) {
  var box = $('#inspector');
  if (!node) {
    box.innerHTML = '<p class="hint">Click a node to focus it — only that node and its '
      + 'connections light up, and you can read its note here. Shift-click a second node '
      + 'to trace the path.</p>';
    return;
  }
  var links = (graph.adj.get(node.id) || []).slice(0, 12);
  var html = '<div class="ititle">' + esc(node.title) + '</div>'
    + '<div class="imeta">' + esc(node.type) + ' · ' + node.degree + ' links'
    + (node.updated ? ' · ' + esc(node.updated) : '') + '</div>'
    + '<div class="ibody">' + esc(node.snippet || 'No body text.') + '</div>';
  if (trace && trace.length > 1) {
    html += '<div class="imeta" style="margin-top:10px">path · ' + trace.length + ' hops</div>'
      + '<div class="ibody">' + trace.map(function (id) {
        var n = graph.byId.get(id); return esc(n ? n.title : id);
      }).join(' → ') + '</div>';
  }
  if (links.length) {
    html += '<div class="ilinks">' + links.map(function (id) {
      var n = graph.byId.get(id);
      return '<span class="chip" data-id="' + esc(id) + '">' + esc(n ? n.title : id) + '</span>';
    }).join('') + '</div>';
  }
  box.innerHTML = html;
  Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (c) {
    c.onclick = function () { focusNode(c.dataset.id); };
  });
}

function focusNode(id) {
  if (graph.setFocus(id, false)) {
    log('mem', 'MEMORY', 'focused ' + id);
  }
}

var MATRIX = [
  ['/recall', 'search vault'], ['/graph', 'reload memory'],
  ['/goal', 'objective'], ['/mission', 'queue'],
  ['/profile', 'remember'], ['/status', 'runtime'],
  ['/new', 'fresh session'], ['/help', 'commands']
];
function renderMatrix() {
  $('#matrix').innerHTML = MATRIX.map(function (m) {
    return '<div class="mcell" data-cmd="' + m[0] + '"><b>' + m[0] + '</b><span>' + m[1] + '</span></div>';
  }).join('');
  Array.prototype.forEach.call($('#matrix').children, function (cell) {
    cell.onclick = function () {
      var cmd = cell.dataset.cmd;
      if (['/recall', '/goal', '/mission', '/profile'].indexOf(cmd) >= 0) {
        $('#ask').value = cmd + ' ';
        $('#ask').focus();
      } else { transmit(cmd); }
    };
  });
}

/* ── data ─────────────────────────────────── */
async function loadGraph(force) {
  var res = await fetch('/api/graph' + (force ? '?force=1' : ''), { headers: headers() });
  GRAPH = await res.json();
  graph.setData(GRAPH);
  renderHubs(); renderFilter();
  $('#stageCount').textContent = GRAPH.total + ' notes · ' + GRAPH.links.length + ' links';
  $('#sVault').textContent = GRAPH.total + ' notes';
  setTimeout(function () { graph.fit(); }, 350);
}

async function loadStatus() {
  try {
    var s = await (await fetch('/api/status', { headers: headers() })).json();
    $('#pGateway').textContent = 'online :' + location.port;
    $('#pBrain').textContent = s.runtime === 'codex' ? (s.version || 'Codex CLI') : 'OFFLINE';
    $('#pVoice').textContent = s.server_voice ? 'Fish Audio' : 'browser';
    document.querySelectorAll('.pill .dot')[2].className = 'dot ' + (s.server_voice ? 'ok' : 'warn');
    $('#sModel').textContent = s.model;
    $('#cliBadge').textContent = s.runtime === 'codex' ? 'CODEX CLI' : 'CLI OFFLINE';
    window.__serverVoice = s.server_voice;
    $('#btnTestVoice').textContent = s.server_voice ? 'Test Fish voice' : 'Test Daniel voice';
    window.__serverSTT = s.server_stt;
    if (s.listener) $('#btnMic').title = 'Listening via ' + s.listener;
  } catch (e) { $('#pGateway').textContent = 'offline'; }
}

/* ── the run ──────────────────────────────── */
async function transmit(message, opts) {
  message = (message || '').trim();
  if (!message) return;
  if (running || Live.speaking) { log('note', 'BUSY', 'still working — "' + message.slice(0, 36) + '" not sent'); return; }
  opts = opts || {};
  running = true;
  answerText = '';
  document.body.classList.remove('boot');
  document.body.classList.add('running');
  if (graph) graph.setActivity(1);
  $('#toneNow').textContent = '—';
  setVoiceState('THINKING', 'hot');
  bubble('me', message);
  answerBubble = bubble('jarvis', '');
  answerBubble.classList.add('thinking');
  log('run', 'RUN', message.slice(0, 70));

  var t0 = performance.now();
  try {
    activeCtl = new AbortController();
    var res = await fetch('/api/run', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ message: message, fresh: /^\/new\b/.test(message) }),
      signal: activeCtl.signal
    });
    if (!res.ok) throw new Error('backend HTTP ' + res.status);
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleEvent(JSON.parse(line));
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') log('note', 'CANCEL', 'run cancelled');
    else { log('error', 'ERROR', String(e).slice(0, 160)); answerBubble.textContent = String(e).slice(0, 160); }
  }
  activeCtl = null;
  running = false;
  document.body.classList.remove('running');
  if (graph) graph.setActivity(0);
  answerBubble.classList.remove('thinking');
  $('#sLatency').textContent = Math.round(performance.now() - t0) + 'ms';
  setVoiceState('IDLE', '');
  if (answerText.trim() && opts.speak !== false) await speak(answerText.trim(), message, answerBubble);
}

function handleEvent(ev) {
  switch (ev.t) {
    case 'status':
      if (ev.session_id) $('#sSession').textContent = ev.session_id.slice(0, 8);
      if (ev.model) $('#sModel').textContent = ev.model;
      log('ok', 'STATUS', 'codex online · tools=' + (ev.tools || 0)
        + ' · permission=' + (ev.permission || '—'));
      break;
    case 'latency':
      $('#sLatency').textContent = ev.ms + 'ms';
      log('note', 'LATENCY', 'first token after ' + ev.ms + 'ms');
      break;
    case 'tool':
      if (ev.phase === 'use') log('tool', 'TOOL', '→ ' + ev.name + '(' + (ev.input || '') + ')');
      else log('tool', 'TOOL', '✓ ' + (ev.ok === false ? 'error' : 'ok'));
      break;
    case 'focus':
      if (graph.setFocus(ev.id, false)) log('mem', 'MEMORY', 'vault hit → ' + ev.id);
      break;
    case 'graph':
      loadGraph(true);
      break;
    case 'delta':
      answerText += ev.text;
      renderSpoken(answerBubble, answerText);
      var tone = lastTone(answerText);
      if (tone) $('#toneNow').textContent = tone;
      $('#transcript').scrollTop = $('#transcript').scrollHeight;
      break;
    case 'usage':
      $('#sTokens').textContent = (ev.total_tokens || 0).toLocaleString();
      break;
    case 'ratelimit':
      $('#sLimit').textContent = (ev.status || '—') + (ev.window ? ' · ' + ev.window.replace('_', ' ') : '');
      break;
    case 'note':
      log('note', 'NOTE', ev.message || '');
      break;
    case 'error':
      log('error', 'ERROR', ev.message || '');
      answerBubble.textContent = ev.message || 'error';
      break;
    case 'complete':
      if (ev.session_id) $('#sSession').textContent = String(ev.session_id).slice(0, 8);
      log('ok', 'DONE', (ev.ms || 0) + 'ms');
      break;
  }
}

/* ── voice ────────────────────────────────── */
function playBlob(blob) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    var cleanup = function () { URL.revokeObjectURL(url); };
    audio.onplaying = function () { log('ok', 'VOICE', 'Fish Audio playback started'); };
    audio.onended = function () { cleanup(); log('ok', 'VOICE', 'Fish Audio playback finished'); resolve(); };
    audio.onerror = function () { cleanup(); reject(new Error('audio playback failed')); };
    audio.play().catch(function (error) { cleanup(); reject(error); });
  });
}

/* Resolves when playback actually FINISHES, not when it starts — live mode
   needs that to know when it is safe to listen again. */
async function speak(text, context, targetBubble, deliveryMode) {
  deliveryMode = deliveryMode || 'auto';
  setVoiceState(window.__serverVoice ? (deliveryMode === 'scripted' ? 'PREPARING VOICE' : 'DIRECTING') : 'SPEAKING', 'hot');
  Live.speaking = true;
  speechCtl = new AbortController();
  try {
    if (window.__serverVoice) {
      try {
        var res = await fetch('/api/speak', {
          method: 'POST', headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ text: text, context: context || '', delivery_mode: deliveryMode }),
          signal: speechCtl.signal
        });
        if (res.ok) {
          var directions = JSON.parse(res.headers.get('X-Jarvis-Delivery') || '[]');
          var directed = text;
          directions.slice().reverse().forEach(function (item) {
            directed = directed.slice(0, item.at) + '[' + item.delivery + '] ' + directed.slice(item.at);
          });
          if (targetBubble) renderSpoken(targetBubble, directed);
          var tags = directed.match(TONE_RE) || [];
          $('#toneNow').textContent = tags[0] || '—';
          log('ok', 'SPEECH TAGS', tags.length ? tags.join(' → ') : 'No delivery tags');
          log('ok', 'SPEECH SCRIPT', directed);
          setVoiceState('SPEAKING', 'hot');
          await playBlob(await res.blob()); return;
        }
        var failure = await res.json();
        log('note', 'VOICE', failure.error || 'Speech preparation failed');
      } catch (e) { log('note', 'VOICE', 'Fish Audio playback failed: ' + e.message); }
      return;
    }
    if (!window.speechSynthesis) return;
    await new Promise(function (resolve) {
      var u = new SpeechSynthesisUtterance(stripTones(text));
      u.voice = speechSynthesis.getVoices().find(function (voice) {
        return voice.name === 'Daniel' && voice.lang === 'en-GB';
      }) || null;
      u.lang = 'en-GB';
      u.rate = 1.02; u.pitch = 0.92;
      // Keep the utterance alive until the browser finishes speaking.
      Live.utterance = u;
      var started = false;
      u.onstart = function () {
        started = true;
        log('ok', 'VOICE', (u.voice ? u.voice.name : 'browser default') + ' playback started');
      };
      u.onend = function () {
        log(started ? 'ok' : 'note', 'VOICE', started ? 'playback finished' : 'browser ended speech without starting audio');
        Live.utterance = null;
        resolve();
      };
      u.onerror = function (e) {
        log('note', 'VOICE', 'playback failed: ' + (e.error || 'unknown error'));
        Live.utterance = null;
        resolve();
      };
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  } finally {
    speechCtl = null;
    Live.speaking = false;
    setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
  }
}

/* ── live voice ───────────────────────────────
   Hold the mic open, watch the input level, and cut an utterance when you stop
   talking. No button press per turn.

   Two things this has to get right:
   - It must not hear JARVIS. Detection is suspended while a turn is running and
     while audio is playing, otherwise the reply gets transcribed as your next
     question and it talks to itself forever.
   - Room tone varies. The threshold is calibrated from your actual noise floor
     at start rather than hardcoded, so a noisy room does not trigger constantly. */
var SILENCE_MS = 1400;     // allow natural pauses without cutting a sentence short
var MIN_SPEECH_MS = 350;   // shorter than this is a cough, not a sentence
var MAX_SPEECH_MS = 20000; // hard stop so a stuck mic cannot record forever

var Live = {
  on: false, speaking: false, armed: false, transcribing: false,
  stream: null, ctx: null, analyser: null, data: null,
  recorder: null, capture: null, listenCtl: null, generation: 0, raf: 0,
  threshold: 0.02, voiceStart: 0, lastVoice: 0,

  async enable() {
    if (Live.on) return;
    if (!window.__serverSTT) {
      log('error', 'VOICE', 'live mode needs server-side transcription — none available');
      return;
    }
    try {
      Live.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      log('error', 'VOICE', 'microphone unavailable: ' + String(e).slice(0, 70));
      return;
    }
    Live.generation += 1;
    var generation = Live.generation;
    var track = Live.stream.getAudioTracks()[0];
    log('note', 'MICROPHONE', track ? track.label : 'System default input');
    if (track) track.onended = function () {
      if (Live.on && generation === Live.generation) {
        log('error', 'MICROPHONE', 'Microphone disconnected. Reconnect it and turn Live on again.');
        Live.disable();
      }
    };
    Live.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (Live.ctx.state === 'suspended') await Live.ctx.resume();
    Live.analyser = Live.ctx.createAnalyser();
    Live.analyser.fftSize = 1024;
    Live.data = new Uint8Array(Live.analyser.fftSize);
    Live.ctx.createMediaStreamSource(Live.stream).connect(Live.analyser);

    Live.on = true;
    document.body.classList.add('live');
    $('#btnMic').classList.add('live');
    setVoiceState('CALIBRATING', 'hot');
    await Live.calibrate();
    if (!Live.on || generation !== Live.generation) return;
    setVoiceState('LISTENING', 'hot');
    log('ok', 'VOICE', 'live mode on — just talk, it sends when you stop');
    Live.loop();
  },

  /* Sample the room for a moment and sit above it. */
  calibrate() {
    return new Promise(function (resolve) {
      var samples = [], t0 = performance.now();
      (function tick() {
        if (!Live.on) return resolve();
        samples.push(Live.level());
        if (performance.now() - t0 < 700) return requestAnimationFrame(tick);
        samples.sort(function (a, b) { return a - b; });
        var floor = samples[Math.floor(samples.length * 0.2)] || 0.005;
        Live.threshold = Math.min(0.035, Math.max(floor * 2.5, 0.008));
        log('note', 'VOICE', 'noise floor ' + floor.toFixed(4)
          + ' → threshold ' + Live.threshold.toFixed(4));
        resolve();
      })();
    });
  },

  level() {
    if (!Live.analyser) return 0;
    Live.analyser.getByteTimeDomainData(Live.data);
    var sum = 0;
    for (var i = 0; i < Live.data.length; i++) {
      var v = (Live.data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / Live.data.length);
  },

  meter(rms) {
    var pct = Math.min(100, Math.round((rms / (Live.threshold * 4)) * 100));
    var el = $('#vuFill');
    if (el) {
      el.style.width = pct + '%';
      el.className = Live.armed ? 'vufill hot' : 'vufill';
    }
  },

  loop() {
    if (!Live.on) return;
    Live.raf = requestAnimationFrame(Live.loop);
    // Never listen while we are thinking or talking.
    if (running || Live.speaking || Live.transcribing) {
      if (Live.armed) Live.discard();
      Live.meter(0);
      return;
    }
    var rms = Live.level();
    Live.meter(rms);
    var now = performance.now();
    if (rms > Live.threshold * (Live.armed ? 0.6 : 1)) Live.lastVoice = now;

    if (!Live.armed) {
      if (rms > Live.threshold) Live.start(now);
      return;
    }
    if (now - Live.voiceStart > MAX_SPEECH_MS) return Live.finish();
    if (now - Live.lastVoice > SILENCE_MS) {
      if (now - Live.voiceStart - SILENCE_MS > MIN_SPEECH_MS) Live.finish();
      else Live.discard();
    }
  },

  start(now) {
    if (!Live.on || Live.armed || Live.transcribing || running || Live.speaking) return;
    try {
      // Each recorder owns its chunks and intent. A later recording cannot
      // replace data that an asynchronous stop/dataavailable callback still needs.
      var capture = { recorder: new MediaRecorder(Live.stream), chunks: [],
        send: false, generation: Live.generation, started: now };
      Live.capture = capture;
      Live.recorder = capture.recorder;
      capture.recorder.ondataavailable = function (e) { if (e.data.size) capture.chunks.push(e.data); };
      capture.recorder.onstop = function () {
        if (!capture.send || !Live.on || capture.generation !== Live.generation) return;
        var blob = new Blob(capture.chunks, { type: capture.recorder.mimeType || 'audio/webm' });
        log('note', 'RECORDING', ((performance.now() - capture.started) / 1000).toFixed(1)
          + ' seconds · ' + Math.round(blob.size / 1024) + ' KB');
        Live.send(blob, capture.generation);
      };
      capture.recorder.onerror = function (event) {
        capture.send = false;
        if (capture.generation !== Live.generation) return;
        Live.armed = Live.transcribing = false;
        log('error', 'VOICE', 'Recording failed: ' + (event.error && event.error.message || 'microphone error'));
        setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
      };
      capture.recorder.start();
      Live.armed = true;
      Live.voiceStart = now;
      Live.lastVoice = now;
      setVoiceState('HEARING', 'hot');
    } catch (e) {
      log('error', 'VOICE', 'recorder failed: ' + String(e).slice(0, 60));
      Live.armed = false;
    }
  },

  finish() {
    if (!Live.armed || !Live.capture) return;
    Live.armed = false;
    Live.transcribing = true;
    Live.capture.send = true;
    setVoiceState('TRANSCRIBING', 'hot');
    try { Live.capture.recorder.stop(); } catch (e) {
      Live.capture.send = false;
      Live.transcribing = false;
      log('error', 'VOICE', 'Could not finish recording: ' + e.message);
      setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
    }
  },

  discard() {
    Live.armed = false;
    if (Live.capture) Live.capture.send = false;
    try { if (Live.recorder && Live.recorder.state === 'recording') Live.recorder.stop(); } catch (e) {}
    setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
  },

  async send(blob, generation) {
    if (!Live.on || generation !== Live.generation) return;
    Live.transcribing = true;
    var ctl = new AbortController();
    Live.listenCtl = ctl;
    var timeout = setTimeout(function () { ctl.abort(); }, 120000);
    try {
      if (!blob.size) throw new Error('The microphone returned an empty recording. Check your input device.');
      var res = await fetch('/api/listen', {
        method: 'POST',
        headers: headers({ 'content-type': blob.type || 'audio/webm' }),
        body: blob, signal: ctl.signal
      });
      var data = await res.json();
      if (!Live.on || generation !== Live.generation) return;
      if (!res.ok) throw new Error(data.error || 'Transcription server returned HTTP ' + res.status);
      var text = (data && data.text || '').trim();
      if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) {
        log('note', 'VOICE', 'No clear speech recognized. Check the microphone shown above and try speaking closer to it.');
        return;
      }
      log('note', 'VOICE', 'heard: "' + text + '"');
      await transmit(text);
    } catch (e) {
      if (Live.on && generation === Live.generation) {
        log('error', 'VOICE', e.name === 'AbortError' ? 'Transcription timed out. Please try again.'
          : 'Transcription failed: ' + String(e.message || e).slice(0, 220));
      }
    } finally {
      clearTimeout(timeout);
      if (generation === Live.generation) {
        Live.listenCtl = null;
        Live.transcribing = false;
        setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
      }
    }
  },

  disable() {
    Live.on = false;
    Live.armed = false;
    Live.generation += 1;
    Live.transcribing = false;
    if (Live.capture) Live.capture.send = false;
    if (Live.listenCtl) Live.listenCtl.abort();
    Live.listenCtl = null;
    cancelAnimationFrame(Live.raf);
    try { if (Live.recorder && Live.recorder.state === 'recording') Live.recorder.stop(); } catch (e) {}
    if (Live.stream) Live.stream.getTracks().forEach(function (t) { t.stop(); });
    if (Live.ctx) { try { Live.ctx.close(); } catch (e) {} }
    Live.stream = Live.ctx = Live.analyser = null;
    document.body.classList.remove('live');
    $('#btnMic').classList.remove('live');
    Live.meter(0);
    setVoiceState('IDLE', '');
    log('note', 'VOICE', 'live mode off');
  }
};

function setupMic() {
  $('#btnMic').onclick = function () {
    if (Live.on) Live.disable(); else Live.enable();
  };
}

/* ── boot ─────────────────────────────────── */
window.addEventListener('DOMContentLoaded', function () {
  graph = new MemoryGraph($('#graph'), {
    onSelect: function (node, trace) { renderInspector(node, trace); }
  });
  window.__jarvisGraph = graph;   // handy from devtools while tuning layout

  // dial ticks
  var ticks = '';
  for (var i = 0; i < 60; i++) {
    var a = (i / 60) * Math.PI * 2, r1 = 92, r2 = i % 5 === 0 ? 82 : 87;
    ticks += '<line x1="' + (100 + Math.cos(a) * r1).toFixed(1) + '" y1="' + (100 + Math.sin(a) * r1).toFixed(1)
      + '" x2="' + (100 + Math.cos(a) * r2).toFixed(1) + '" y2="' + (100 + Math.sin(a) * r2).toFixed(1)
      + '" stroke="rgba(95,228,255,' + (i % 5 === 0 ? '.35' : '.15') + ')" stroke-width="1"/>';
  }
  $('#ticks').innerHTML = ticks;

  renderMatrix();
  loadStatus();
  loadGraph(false);
  setupMic();
  setVoiceState('IDLE', '');

  $('#btnSend').onclick = function () { var v = $('#ask').value; $('#ask').value = ''; transmit(v); };
  $('#btnTestVoice').onclick = function () {
    if (!running && !Live.speaking) speak(window.__serverVoice
      ? 'All systems are online. Your assistant is powered by GPT six Astra. I shall try to keep the theatrics to a minimum.'
      : 'Daniel is online. Your assistant is now powered by GPT six Astra.');
  };
  $('#ask').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var v = $('#ask').value; $('#ask').value = ''; transmit(v); }
  });
  $('#btnFit').onclick = function () { graph.fit(); };
  $('#btnLabels').onclick = function () {
    graph.showLabels = !graph.showLabels;
    $('#btnLabels').classList.toggle('on', graph.showLabels);
  };
  $('#btnDim').onclick = function () {
    graph.dim = !graph.dim;
    $('#btnDim').classList.toggle('on', graph.dim);
  };
  $('#btnLabels').classList.add('on');

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (activeCtl) activeCtl.abort();
      if (speechCtl) speechCtl.abort();
      fetch('/api/cancel', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' });
      graph.setFocus(null);
    }
    if (e.key === '/' && document.activeElement !== $('#ask')) { e.preventDefault(); $('#ask').focus(); }
  });

  setInterval(loadStatus, 20000);
  log('ok', 'BOOT', 'HUD online · codex · local vault');
});
