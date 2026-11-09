// Simple synthesized sound: rotor hum + beeps. No audio files needed.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.volume = 0.5;
    this.hum = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume * 0.5;
      this.master.connect(this.ctx.destination);

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      const humGain = this.ctx.createGain();
      humGain.gain.value = 0;
      const o1 = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      o1.type = 'sawtooth';
      o2.type = 'sawtooth';
      o1.connect(filter);
      o2.connect(filter);
      filter.connect(humGain);
      humGain.connect(this.master);
      o1.start();
      o2.start();
      this.hum = { o1, o2, filter, gain: humGain };
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.ctx = null;
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v * 0.5;
  }

  // load 0..1 (how hard the drone is working); on = rotors spinning
  rotor(on, load) {
    if (!this.hum || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 70 + 110 * load;
    this.hum.o1.frequency.setTargetAtTime(f, t, 0.08);
    this.hum.o2.frequency.setTargetAtTime(f * 1.012, t, 0.08);
    this.hum.filter.frequency.setTargetAtTime(500 + 900 * load, t, 0.1);
    this.hum.gain.gain.setTargetAtTime(on ? 0.22 : 0, t, 0.2);
  }

  beep(freqs = [660], dur = 0.12, type = 'sine') {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      const s = t0 + i * dur;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.5, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
      o.connect(g);
      g.connect(this.master);
      o.start(s);
      o.stop(s + dur + 0.02);
    });
  }

  click() { this.beep([520], 0.05, 'triangle'); }
  pickup() { this.beep([523, 659, 784], 0.1); }
  deliver() { this.beep([523, 659, 784, 1047], 0.12); }
  bump() { this.beep([160, 110], 0.12, 'square'); }
  fail() { this.beep([330, 260, 190], 0.18, 'sawtooth'); }
  buy() { this.beep([784, 988, 1175], 0.09); }
}
