// AudioWorklet: mudança de tom (pitch shift em tempo real, granular com 2 grãos cruzados)
// + efeitos simples (robô). Roda na thread de áudio, sem travar a interface.
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' },
      { name: 'robot', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.size = 16384;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.win = Math.round(sampleRate * 0.05); // grão de 50 ms
    this.phase = 0;
    this.ringPhase = 0;
  }
  read(pos) {
    const n = this.size;
    let i = Math.floor(pos); const f = pos - i;
    i = ((i % n) + n) % n;
    const a = this.buf[i], b = this.buf[(i + 1) % n];
    return a + (b - a) * f;
  }
  process(inputs, outputs, params) {
    const input = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    if (!out) return true;
    const pitch = params.pitch[0];
    const robot = params.robot[0];
    const W = this.win;
    for (let s = 0; s < out.length; s++) {
      const x = input ? input[s] : 0;
      this.buf[this.w] = x;
      let y;
      if (Math.abs(pitch - 1) < 0.001) y = x;
      else {
        // dois grãos defasados em meia janela, com envelope triangular
        this.phase += (1 - pitch);
        if (this.phase >= W) this.phase -= W;
        if (this.phase < 0) this.phase += W;
        const d1 = this.phase, d2 = (this.phase + W / 2) % W;
        const g1 = 1 - Math.abs(2 * d1 / W - 1), g2 = 1 - Math.abs(2 * d2 / W - 1);
        y = this.read(this.w - d1 - 1) * g1 + this.read(this.w - d2 - 1) * g2;
      }
      if (robot > 0) { // modulação em anel = voz metálica
        this.ringPhase += 2 * Math.PI * 55 / sampleRate;
        if (this.ringPhase > 6.283185307) this.ringPhase -= 6.283185307;
        y = y * (1 - robot) + y * Math.sin(this.ringPhase) * robot * 1.6;
      }
      out[s] = y;
      this.w = (this.w + 1) % this.size;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('resenha-pitch', PitchShifter);
