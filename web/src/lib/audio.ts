let audioCtx: AudioContext | null = null;
let alarmSource: AudioBufferSourceNode | null = null;
let gainNode: GainNode | null = null;

function generateAlarmBuffer(ctx: AudioContext): AudioBuffer {
  // 1秒のビープ音を合成（440Hz + 880Hz の和音）
  const sampleRate = ctx.sampleRate;
  const duration = 0.8;
  const buffer = ctx.createBuffer(1, sampleRate * duration, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const envelope = t < 0.05 ? t / 0.05 : t > 0.7 ? (0.8 - t) / 0.1 : 1;
    data[i] = envelope * (
      0.6 * Math.sin(2 * Math.PI * 880 * t) +
      0.4 * Math.sin(2 * Math.PI * 1320 * t)
    );
  }
  return buffer;
}

export function startAlarm(): void {
  if (alarmSource) return;

  audioCtx = new AudioContext();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 1.0;
  gainNode.connect(audioCtx.destination);

  const buffer = generateAlarmBuffer(audioCtx);
  alarmSource = audioCtx.createBufferSource();
  alarmSource.buffer = buffer;
  alarmSource.loop = true;
  alarmSource.connect(gainNode);
  alarmSource.start();
}

export function stopAlarm(): void {
  if (alarmSource) {
    alarmSource.stop();
    alarmSource.disconnect();
    alarmSource = null;
  }
  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }
  if (audioCtx) {
    void audioCtx.close();
    audioCtx = null;
  }
}

export function isAlarmPlaying(): boolean {
  return alarmSource !== null;
}
