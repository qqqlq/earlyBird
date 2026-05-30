/** DeviceMotionを使ったスクワット回数カウンター */

type RepCounterOptions = {
  onRep: (count: number) => void;
  threshold?: number;     // ピーク検出の加速度しきい値 (m/s²)
  minIntervalMs?: number; // 誤検出防止の最短インターバル
};

let motionHandler: ((e: DeviceMotionEvent) => void) | null = null;
let repCount = 0;
let lastRepTime = 0;
let phase: 'idle' | 'down' | 'up' = 'idle';

const DEFAULT_THRESHOLD = 12;   // m/s²
const DEFAULT_MIN_INTERVAL = 600; // ms

export async function requestMotionPermission(): Promise<boolean> {
  // iOS 13+ は明示的な許可が必要
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission === 'function') {
    const perm = await (DeviceMotionEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission();
    return perm === 'granted';
  }
  // Android / デスクトップ はデフォルトで許可
  return typeof DeviceMotionEvent !== 'undefined';
}

export function startRepCounter(
  onRep: (count: number) => void,
  options: Partial<RepCounterOptions> = {},
): void {
  if (motionHandler) stopRepCounter();

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL;
  repCount = 0;
  lastRepTime = 0;
  phase = 'idle';

  motionHandler = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc) return;

    // 上下成分（y軸）の絶対値で判定
    const ay = Math.abs(acc.y ?? 0);

    const now = Date.now();

    if (phase === 'idle' || phase === 'up') {
      // 大きな加速度 = 立ち上がる瞬間
      if (ay > threshold && now - lastRepTime > minInterval) {
        phase = 'up';
        repCount++;
        lastRepTime = now;
        onRep(repCount);
        // 次のdown検出のためにフェーズをリセット
        setTimeout(() => {
          if (phase === 'up') phase = 'idle';
        }, 400);
      }
    }
  };

  window.addEventListener('devicemotion', motionHandler);
}

export function stopRepCounter(): void {
  if (motionHandler) {
    window.removeEventListener('devicemotion', motionHandler);
    motionHandler = null;
  }
  repCount = 0;
  phase = 'idle';
}

export function getRepCount(): number {
  return repCount;
}

/** PC開発用: 加速度センサーが使えない環境でカウントを手動インクリメント */
export function debugIncrementRep(onRep: (count: number) => void): void {
  repCount++;
  onRep(repCount);
}
