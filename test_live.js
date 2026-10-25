const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const logs = [], states = [], recorders = [];
  const element = { content: 'test', classList: { add() {}, remove() {} }, style: {} };
  const ctx = {
    document: { querySelector: () => element, body: element },
    window: { addEventListener() {} }, Blob, AbortController, setTimeout, clearTimeout,
    performance: { now: () => 3000 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    MediaRecorder: class {
      constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; } // callbacks are deliberately delayed by tests
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/ui/app.js', 'utf8'), ctx);
  ctx.log = (...args) => logs.push(args);
  ctx.setVoiceState = state => states.push(state);
  ctx.Live.on = true;
  ctx.Live.generation = 1;
  return { ctx, logs, states, recorders };
}

(async () => {
  {
    const { ctx } = fixture();
    let starts = 0, finishes = 0;
    ctx.Live.level = () => 1;
    ctx.Live.start = () => { starts += 1; };
    ctx.Live.transcribing = true;
    ctx.Live.loop();
    assert.equal(starts, 0, 'Loud input cannot start another clip during transcription');
    ctx.Live.transcribing = false;
    ctx.Live.armed = true;
    ctx.Live.level = () => 0.013;
    ctx.Live.threshold = 0.02;
    ctx.Live.finish = () => { finishes += 1; };
    ctx.Live.loop();
    assert.equal(ctx.Live.lastVoice, 3000, 'Quiet speech sustains an already-started recording');
    assert.equal(finishes, 0);
  }
  {
    const { ctx, recorders } = fixture();
    let sent;
    ctx.Live.send = async blob => { sent = await blob.text(); };
    ctx.Live.start(0);
    ctx.Live.finish();
    assert.equal(ctx.Live.transcribing, true);
    ctx.Live.start(1000);
    assert.equal(recorders.length, 1, 'No second recorder while stop/transcription is pending');
    recorders[0].ondataavailable({ data: new Blob(['original recording']) });
    recorders[0].onstop();
    await new Promise(setImmediate);
    assert.equal(sent, 'original recording');
  }
  {
    const { ctx, recorders } = fixture();
    let sent = false;
    ctx.Live.send = () => { sent = true; };
    ctx.Live.start(0);
    ctx.Live.finish();
    ctx.Live.disable();
    recorders[0].ondataavailable({ data: new Blob(['stale']) });
    recorders[0].onstop();
    assert.equal(sent, false, 'Disabling Live must cancel queued recorder callbacks');
  }
  {
    const { ctx, logs, states } = fixture();
    ctx.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'whisper failed: device unavailable' }) });
    await ctx.Live.send(new Blob(['audio']), 1);
    assert.ok(logs.some(row => row[0] === 'error' && row[2].includes('device unavailable')));
    assert.ok(!logs.some(row => row[2].includes('No clear speech')));
    assert.equal(ctx.Live.transcribing, false);
    assert.equal(states.at(-1), 'LISTENING');
  }
  {
    const { ctx } = fixture();
    let finishReply, received;
    ctx.fetch = async () => ({ ok: true, json: async () => ({ text: 'Καλημέρα' }) });
    ctx.transmit = text => { received = text; return new Promise(resolve => { finishReply = resolve; }); };
    const pending = ctx.Live.send(new Blob(['audio']), 1);
    await new Promise(setImmediate);
    assert.equal(received, 'Καλημέρα', 'Valid non-English speech must not be discarded');
    assert.equal(ctx.Live.transcribing, true, 'Keep input locked through reply playback');
    finishReply();
    await pending;
    assert.equal(ctx.Live.transcribing, false);
  }
  {
    const { ctx } = fixture();
    let finishFetch, transmitted = false, signal;
    ctx.fetch = (_, options) => { signal = options.signal; return new Promise(resolve => { finishFetch = resolve; }); };
    ctx.transmit = () => { transmitted = true; };
    const pending = ctx.Live.send(new Blob(['audio']), 1);
    ctx.Live.disable();
    assert.equal(signal.aborted, true);
    finishFetch({ ok: true, json: async () => ({ text: 'Old request' }) });
    await pending;
    assert.equal(transmitted, false, 'Ignore late transcripts from a previous Live session');
  }
  console.log('Live recording isolation, input lock, errors, Unicode, and cancellation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
