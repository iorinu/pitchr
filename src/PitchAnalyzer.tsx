import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  Upload, Play, Pause, ZoomIn, ZoomOut, Wand2, Trash2,
  Footprints, Activity, Gauge, Crosshair, FlagTriangleRight,
  FlagTriangleLeft, RotateCcw, MapPin, MapPinOff, StepBack, StepForward,
} from "lucide-react";
import { pickMediaFile } from "./lib/openMediaFile";
import { extractWaveform, type Waveform } from "./lib/extractWaveform";

// ============================================================
// PITCHR — 接地音ベース ピッチ解析
//   - 動画/音声を読み込み、波形を取得（Tauri なら ffmpeg sidecar 経由、Web なら decodeAudioData）
//   - 動画と波形を同期再生（映像で接地を目視確認しながら調整）
//   - 解析区間(スタート/エンド)を指定 → 区間内だけでピッチ算出
//   - ピッチは「歩/秒」(短距離想定)
// ============================================================

function detectOnsets(
  channelData: Float32Array,
  sampleRate: number,
  sensitivity: number,
  a: number | null,
  b: number | null,
): number[] {
  const frameSize = 1024;
  const hop = 256;
  const s0 = a != null ? Math.floor(a * sampleRate) : 0;
  const s1 = b != null ? Math.floor(b * sampleRate) : channelData.length;
  const region = channelData.subarray(
    Math.max(0, s0),
    Math.min(channelData.length, s1),
  );
  const baseT = a != null ? a : 0;
  const nFrames = Math.floor((region.length - frameSize) / hop);
  if (nFrames <= 0) return [];

  // 短時間 RMS の正方向差分（エンベロープ フラックス）を計算
  const flux = new Float32Array(nFrames);
  let prevRms = 0;
  for (let i = 0; i < nFrames; i++) {
    const start = i * hop;
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = region[start + j];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frameSize);
    const d = rms - prevRms;
    flux[i] = d > 0 ? d : 0;
    prevRms = rms;
  }

  // 動画ごとに音量レベルが違うので、平均+k*標準偏差で相対閾値
  const mean = flux.reduce((x, y) => x + y, 0) / nFrames;
  const variance =
    flux.reduce((x, y) => x + (y - mean) * (y - mean), 0) / nFrames;
  const std = Math.sqrt(variance);
  const k = 2.2 - sensitivity * 1.9;
  const thresh = mean + k * std;
  const minGapFrames = Math.floor((0.13 * sampleRate) / hop);

  const onsets: number[] = [];
  let lastPeak = -minGapFrames * 2;
  for (let i = 1; i < nFrames - 1; i++) {
    if (
      flux[i] > thresh &&
      flux[i] >= flux[i - 1] &&
      flux[i] > flux[i + 1] &&
      i - lastPeak >= minGapFrames
    ) {
      onsets.push(baseT + (i * hop + frameSize / 2) / sampleRate);
      lastPeak = i;
    }
  }
  return onsets;
}

type PitchResult = {
  avg: number;
  median: number;
  min: number;
  max: number;
  steps: number;
  duration: number;
  instant: number[];
};

// 1歩ごとの時間情報。接地マーカーから累積時間と直前との差分を計算する。
// 累積の基準は区間開始(regionStart)。区間が未設定なら最初の接地を 0 とする。
type StepRow = {
  idx: number;
  t: number;     // 動画上の絶対時刻 (秒)
  cum: number;   // 区間開始からの累積時間 (秒)
  gap: number | null; // 直前の接地からの Δt (秒)。最初の接地は null
  ips: number | null; // 1/Δt = 歩/秒
};
function computeStepRows(
  markers: number[],
  a: number | null,
  b: number | null,
): StepRow[] {
  let ms = [...markers].sort((x, y) => x - y);
  if (a != null && b != null) ms = ms.filter((m) => m >= a && m <= b);
  if (ms.length === 0) return [];
  const base = a ?? ms[0];
  return ms.map((t, i) => ({
    idx: i + 1,
    t,
    cum: t - base,
    gap: i > 0 ? t - ms[i - 1] : null,
    ips: i > 0 && t - ms[i - 1] > 0 ? 1 / (t - ms[i - 1]) : null,
  }));
}

// ピッチ = 歩/秒。区間 [a,b] が指定されていれば範囲内マーカーのみ。
function computePitch(
  markers: number[],
  a: number | null,
  b: number | null,
): PitchResult | null {
  let t = [...markers].sort((x, y) => x - y);
  if (a != null && b != null) t = t.filter((m) => m >= a && m <= b);
  if (t.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i] - t[i - 1]);
  const instant = gaps.map((g) => 1 / g); // 歩/秒
  const avg = (t.length - 1) / (t[t.length - 1] - t[0]); // 歩/秒
  const sorted = [...instant].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    avg,
    median,
    min: Math.min(...instant),
    max: Math.max(...instant),
    steps: t.length,
    duration: t[t.length - 1] - t[0],
    instant,
  };
}

type DragState =
  | { type: "marker"; idx: number }
  | { type: "region"; edge: "start" | "end" }
  | null;

export default function PitchAnalyzer() {
  const [waveform, setWaveform] = useState<Waveform | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [markers, setMarkers] = useState<number[]>([]);
  const [regionStart, setRegionStart] = useState<number | null>(null);
  const [regionEnd, setRegionEnd] = useState<number | null>(null);
  const [pxPerSec, setPxPerSec] = useState(120);
  const [scroll, setScroll] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [videoFps, setVideoFps] = useState(60);
  const [status, setStatus] = useState("");
  const [fileName, setFileName] = useState("");
  const [viewW, setViewW] = useState(900);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const rafRef = useRef<number>(0);
  const dragRef = useRef<DragState>(null);

  const mediaDur = mediaRef.current?.duration;
  const dur =
    waveform?.duration ?? (mediaDur && isFinite(mediaDur) ? mediaDur : 0);

  const openFile = async () => {
    setStatus("ファイル選択中...");
    let picked;
    try {
      picked = await pickMediaFile();
    } catch (e) {
      setStatus("ファイル選択キャンセル / エラー");
      return;
    }
    if (!picked) {
      setStatus("");
      return;
    }
    setFileName(picked.fileName);
    setIsVideo(
      /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(picked.fileName) ||
        !!picked.blob?.type.startsWith("video"),
    );
    setMediaUrl(picked.srcUrl);
    setMarkers([]);
    setRegionStart(null);
    setRegionEnd(null);
    setScroll(0);
    setPlayhead(0);
    setWaveform(null);
    setStatus("波形抽出中...");
    try {
      const wf = await extractWaveform(picked, (stage) =>
        setStatus(`波形抽出中: ${stage}`),
      );
      setWaveform(wf);
      setStatus(
        `読込完了 (${wf.duration.toFixed(1)}s / ${wf.sampleRate}Hz)`,
      );
    } catch (e) {
      console.error(e);
      setWaveform(null);
      setStatus(
        "波形抽出失敗(動画は再生可)。" +
          (e instanceof Error ? ` / ${e.message}` : ""),
      );
    }
  };

  const autoDetect = () => {
    if (!waveform) return;
    const found = detectOnsets(
      waveform.mono,
      waveform.sampleRate,
      sensitivity,
      regionStart,
      regionEnd,
    );
    setMarkers(found);
    setStatus(`自動検出: ${found.length} 個`);
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = viewW,
      H = 220;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const tStart = scroll,
      tEnd = scroll + W / pxPerSec,
      mid = H / 2;

    // グリッド
    g.strokeStyle = "rgba(255,255,255,0.06)";
    g.fillStyle = "rgba(255,255,255,0.30)";
    g.font = "10px ui-monospace, monospace";
    const gridStep = pxPerSec > 200 ? 0.25 : pxPerSec > 80 ? 0.5 : 1;
    for (
      let t = Math.ceil(tStart / gridStep) * gridStep;
      t < tEnd;
      t += gridStep
    ) {
      const x = (t - scroll) * pxPerSec;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
      g.fillText(t.toFixed(2) + "s", x + 3, 12);
    }

    // 区間外マスク
    if (regionStart != null) {
      const xs = (regionStart - scroll) * pxPerSec;
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(0, 0, Math.max(0, Math.min(W, xs)), H);
    }
    if (regionEnd != null) {
      const xe = (regionEnd - scroll) * pxPerSec;
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(Math.max(0, xe), 0, W - Math.max(0, xe), H);
    }

    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(W, mid);
    g.stroke();

    // 波形
    if (waveform) {
      const sr = waveform.sampleRate;
      const mono = waveform.mono;
      const startSample = Math.max(0, Math.floor(tStart * sr));
      const samplesPerPx = sr / pxPerSec;
      g.strokeStyle = "#f5b942";
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x < W; x++) {
        const sa = Math.floor(startSample + x * samplesPerPx);
        const sb = Math.floor(startSample + (x + 1) * samplesPerPx);
        if (sa >= mono.length) break;
        let mn = 1,
          mx = -1;
        for (let i = sa; i < sb && i < mono.length; i++) {
          const v = mono[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        g.moveTo(x, mid - mx * mid * 0.9);
        g.lineTo(x, mid - mn * mid * 0.9);
      }
      g.stroke();
    } else {
      g.fillStyle = "#4a4d57";
      g.font = "12px ui-monospace";
      g.fillText("波形なし(動画は再生できます)", 12, mid);
    }

    // 区間ハンドル
    const drawRegionLine = (
      t: number | null,
      color: string,
      leftFlag: boolean,
    ) => {
      if (t == null) return;
      const x = (t - scroll) * pxPerSec;
      if (x < -10 || x > W + 10) return;
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
      g.fillStyle = color;
      g.fillRect(leftFlag ? x : x - 10, H - 16, 10, 16);
    };
    drawRegionLine(regionStart, "#3ddc84", true);
    drawRegionLine(regionEnd, "#ff9d2e", false);

    // マーカー(区間外は薄く)
    markers.forEach((t) => {
      const x = (t - scroll) * pxPerSec;
      if (x < -2 || x > W + 2) return;
      const inRange =
        (regionStart == null || t >= regionStart) &&
        (regionEnd == null || t <= regionEnd);
      g.strokeStyle = inRange ? "#ff3b4e" : "rgba(255,59,78,0.3)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x, 14);
      g.lineTo(x, H);
      g.stroke();
      g.fillStyle = g.strokeStyle;
      g.beginPath();
      g.moveTo(x - 5, 14);
      g.lineTo(x + 5, 14);
      g.lineTo(x, 22);
      g.closePath();
      g.fill();
    });

    // 再生ヘッド
    const px = (playhead - scroll) * pxPerSec;
    if (px >= 0 && px <= W) {
      g.strokeStyle = "#5ad1ff";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, H);
      g.stroke();
    }

    // ドラッグ中ツールチップ: 操作中の要素の時刻を波形上に数値表示。
    // dragRef は ref で再レンダーをトリガーしないが、ドラッグ中は onMouseMove で
    // markers/region state が変わって draw が呼び直されるので、自動で更新される。
    const drag = dragRef.current;
    let dragT: number | null = null;
    if (drag?.type === "marker") {
      dragT = markers[drag.idx] ?? null;
    } else if (drag?.type === "region") {
      dragT = drag.edge === "start" ? regionStart : regionEnd;
    }
    if (dragT != null) {
      const dx = (dragT - scroll) * pxPerSec;
      const label = dragT.toFixed(3) + "s";
      g.font = "11px ui-monospace, monospace";
      const tw = g.measureText(label).width;
      const lx = Math.max(4, Math.min(W - tw - 12, dx + 8));
      const ly = 36;
      g.fillStyle = "rgba(20, 22, 28, 0.92)";
      g.fillRect(lx - 4, ly - 12, tw + 8, 18);
      g.fillStyle = "#fff";
      g.fillText(label, lx, ly);
    }
  }, [waveform, markers, pxPerSec, scroll, playhead, viewW, regionStart, regionEnd]);

  useEffect(() => {
    draw();
  }, [draw]);

  // 再生速度（playbackRate）を <video>/<audio> 要素に反映。
  // 要素が isVideo/mediaUrl の変化で作り直されるので、それらにも依存させる。
  useEffect(() => {
    if (mediaRef.current) mediaRef.current.playbackRate = playbackRate;
  }, [playbackRate, mediaUrl, isVideo]);

  // キーボードショートカット:
  //   Space  = 再生/停止
  //   M      = 現在位置にマーカー（Shift+M でスナップ無効）
  //   ← / →  = コマ送り (1/fps 秒)
  // input/range/textarea にフォーカスがある時は無効化（感度スライダー操作を邪魔しないため）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        addMarkerAtPlayhead(e.shiftKey);
      } else if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        removeMarkerAtPlayhead();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFrame(e.shiftKey ? -5 : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepFrame(e.shiftKey ? 5 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 依存に並べているのは、各ハンドラが最新の state クロージャを掴むため。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playhead, mediaUrl, dur, viewW, pxPerSec, scroll, regionStart, videoFps, waveform, markers]);
  useEffect(() => {
    const upd = () => {
      if (wrapRef.current) setViewW(wrapRef.current.clientWidth);
    };
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);

  const xToTime = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return scroll + (clientX - rect.left) / pxPerSec;
  };
  const tol = () => 7 / pxPerSec;
  const nearestMarker = (t: number) => {
    let best = -1,
      bestD = Infinity;
    markers.forEach((m, i) => {
      const d = Math.abs(m - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD <= tol() ? best : -1;
  };

  const seek = (t: number) => {
    const v = Math.max(0, Math.min(dur || t, t));
    setPlayhead(v);
    if (mediaRef.current) mediaRef.current.currentTime = v;
  };

  const onMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const t = xToTime(e.clientX);
    if (regionStart != null && Math.abs(t - regionStart) <= tol()) {
      dragRef.current = { type: "region", edge: "start" };
      return;
    }
    if (regionEnd != null && Math.abs(t - regionEnd) <= tol()) {
      dragRef.current = { type: "region", edge: "end" };
      return;
    }
    const idx = nearestMarker(t);
    if (idx >= 0) {
      dragRef.current = { type: "marker", idx };
      return;
    }
    seek(t); // 空き場所クリック=シーク
  };
  const onMouseMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    const t = Math.max(0, Math.min(dur, xToTime(e.clientX)));
    const d = dragRef.current;
    if (d.type === "marker") {
      setMarkers((m) => {
        const c = [...m];
        c[d.idx] = t;
        return c;
      });
    } else if (d.type === "region") {
      if (d.edge === "start") setRegionStart(t);
      else setRegionEnd(t);
    }
  };
  const onMouseUp = () => {
    if (dragRef.current?.type === "marker")
      setMarkers((m) => [...m].sort((a, b) => a - b));
    dragRef.current = null;
  };
  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const t0 = xToTime(e.clientX);
    const idx = nearestMarker(t0);
    if (idx >= 0) {
      setMarkers((m) => m.filter((_, i) => i !== idx));
      return;
    }
    // 追加: 既定はスナップなし（生のクリック位置）。Shift 押下時のみ波形ピークに吸着。
    const t = e.shiftKey ? snapToOnset(t0) : t0;
    setMarkers((m) => [...m, t].sort((a, b) => a - b));
  };

  // 1フレーム単位のコマ送り。短距離の接地は数フレームで状態が変わるので
  // 通常再生で止めるのは無理。一度 pause してから currentTime を ±1/fps 動かす。
  // 注: video.currentTime は実際の動画フレームに丸められるが、視覚的には
  //     ほぼ「次のフレーム」に進む。ffmpeg/ffprobe 経由で正確な fps を取れば
  //     更に厳密にできるが、今は input で fps を指定する方針。
  const stepFrame = (delta: number) => {
    const el = mediaRef.current;
    if (!el || !mediaUrl) return;
    el.pause();
    setPlaying(false);
    const fps = videoFps > 0 ? videoFps : 60;
    const newT = Math.max(0, Math.min(dur || el.currentTime, el.currentTime + delta / fps));
    el.currentTime = newT;
    setPlayhead(newT);
  };

  // 指定時刻の近傍にある波形の急な立ち上がり（接地音らしいフラックスのピーク）に
  // スナップする。detectOnsets と同じ式（RMS の正方向差分）の局所最大を探す。
  // halfWindowSec は探索半径（デフォルト 50ms）。接地音は1フレーム以内に立ち
  // 上がるので、目視で「だいたい合ってる」位置からピン留めできる程度の幅を取る。
  const snapToOnset = (t: number, halfWindowSec = 0.05): number => {
    if (!waveform) return t;
    const { mono, sampleRate } = waveform;
    const frameSize = 1024;
    const hop = 256;
    const center = Math.floor(t * sampleRate);
    const winSamples = Math.floor(halfWindowSec * sampleRate);
    const s0 = Math.max(0, center - winSamples);
    const s1 = Math.min(mono.length - frameSize, center + winSamples);
    if (s1 <= s0) return t;
    let prevRms = 0;
    let bestPos = -1;
    let bestFlux = -Infinity;
    for (let pos = s0; pos < s1; pos += hop) {
      let sum = 0;
      for (let j = 0; j < frameSize; j++) {
        const s = mono[pos + j];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / frameSize);
      const d = rms - prevRms;
      const flux = d > 0 ? d : 0;
      if (flux > bestFlux) {
        bestFlux = flux;
        bestPos = pos;
      }
      prevRms = rms;
    }
    if (bestPos < 0) return t;
    return (bestPos + frameSize / 2) / sampleRate;
  };

  // 現在の再生ヘッド位置に接地マーカーを追加。
  // 既定は **スナップなし**（再生位置をそのまま採用）。これはスロー再生 + コマ送りで
  // 正確に合わせた位置を勝手に動かされたくないため。Shift 押下時のみ波形ピークに吸着する。
  // 既存マーカーと 1ms 以内に重なる場合は無視（誤連打ガード）。
  const addMarkerAtPlayhead = (snap = false) => {
    if (!mediaUrl) return;
    const t = snap ? snapToOnset(playhead) : playhead;
    setMarkers((m) => {
      if (m.some((mm) => Math.abs(mm - t) < 0.001)) return m;
      return [...m, t].sort((a, b) => a - b);
    });
  };

  // 現在の再生ヘッドに最も近いマーカーを削除（±100ms 以内のみ）。
  // 100ms は短距離の接地間隔(~200ms)の半分。これより遠いなら別の歩のマーカー
  // を指していて誤削除になるので何もしない。
  const removeMarkerAtPlayhead = () => {
    if (!mediaUrl || markers.length === 0) return;
    const tol = 0.1;
    let bestIdx = -1;
    let bestD = Infinity;
    markers.forEach((m, i) => {
      const d = Math.abs(m - playhead);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    });
    if (bestIdx < 0 || bestD > tol) {
      setStatus("再生位置の近く (±100ms) にマーカーがありません");
      return;
    }
    setMarkers((m) => m.filter((_, i) => i !== bestIdx));
  };

  // ホイールで波形スクロール（拡大時用）。
  // 横ホイール（トラックパッド二本指水平）と Shift+縦ホイールを波形のスクロールに割り当てる。
  // 画面下のスライダーは「再生プログレスバー」に役割を譲ったため、ここでスクロール手段を担保する。
  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (dx === 0) return;
    const delta = dx / pxPerSec;
    setScroll((s) =>
      Math.max(0, Math.min(Math.max(0, dur - viewW / pxPerSec), s + delta)),
    );
  };

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      cancelAnimationFrame(rafRef.current);
      setPlaying(false);
      return;
    }
    if (playhead >= dur) el.currentTime = regionStart || 0;
    el.play();
    setPlaying(true);
    const tick = () => {
      const pos = el.currentTime;
      setPlayhead(pos);
      const vis = viewW / pxPerSec;
      if (pos < scroll || pos > scroll + vis * 0.95)
        setScroll(Math.max(0, pos - vis * 0.3));
      if (el.paused || el.ended) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const zoom = (f: number) =>
    setPxPerSec((p) => Math.max(20, Math.min(2000, p * f)));
  const pitch = computePitch(markers, regionStart, regionEnd);
  const stepRows = computeStepRows(markers, regionStart, regionEnd);

  return (
    <div style={S.root}>
      <div style={S.header}>
        <div style={S.brand}>
          <Footprints size={22} color="#ff3b4e" />
          <span style={S.title}>PITCHR</span>
          <span style={S.sub}>接地音ピッチ解析</span>
        </div>
        <button style={S.uploadBtn} onClick={openFile}>
          <Upload size={15} />
          <span>動画 / 音声を読込</span>
        </button>
      </div>

      <div style={S.cards}>
        <Stat
          label="平均ピッチ"
          value={pitch ? pitch.avg.toFixed(2) : "—"}
          unit="歩/秒"
          icon={<Gauge size={15} />}
          big
        />
        <Stat
          label="中央値"
          value={pitch ? pitch.median.toFixed(2) : "—"}
          unit="歩/秒"
          icon={<Activity size={15} />}
        />
        <Stat
          label="接地数(区間内)"
          value={pitch ? String(pitch.steps) : "0"}
          unit="歩"
          icon={<Crosshair size={15} />}
        />
        <Stat
          label="区間長"
          value={pitch ? pitch.duration.toFixed(2) : "—"}
          unit="秒"
          icon={<Activity size={15} />}
        />
      </div>

      <div style={S.stage}>
        {isVideo && mediaUrl ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={mediaUrl}
            style={S.video}
            playsInline
          />
        ) : (
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={mediaUrl || undefined}
          />
        )}

        <div style={S.timeBar}>
          <span style={S.timeNow}>{playhead.toFixed(3)}</span>
          <span style={S.timeSep}>/</span>
          <span style={S.timeTotal}>{dur > 0 ? dur.toFixed(2) : "—"}s</span>
        </div>

        <div ref={wrapRef} style={S.waveWrap}>
          <canvas
            ref={canvasRef}
            style={{ display: "block", cursor: "crosshair" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onDoubleClick={onDoubleClick}
            onWheel={onWheel}
          />
          {!mediaUrl && (
            <div style={S.empty}>動画 or 音声ファイルを読み込んでください</div>
          )}
        </div>
      </div>

      {mediaUrl && dur > 0 && (
        <input
          type="range"
          min={0}
          max={dur}
          step={0.01}
          value={Math.min(playhead, dur)}
          onChange={(e) => seek(parseFloat(e.target.value))}
          style={S.scrollbar}
          aria-label="再生位置"
        />
      )}

      <div style={S.controls}>
        <button style={S.iconBtn} onClick={togglePlay} disabled={!mediaUrl}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {playing ? "停止" : "再生"}
        </button>
        <button
          style={S.iconBtn}
          onClick={() => stepFrame(-1)}
          disabled={!mediaUrl}
          title="1フレーム戻す (←) / Shift+← で5フレーム"
        >
          <StepBack size={16} />
          −1f
        </button>
        <button
          style={S.iconBtn}
          onClick={() => stepFrame(1)}
          disabled={!mediaUrl}
          title="1フレーム進める (→) / Shift+→ で5フレーム"
        >
          <StepForward size={16} />
          +1f
        </button>
        <div style={S.sliderGroup}>
          <span style={S.sliderLabel}>fps</span>
          <input
            type="number"
            min={1}
            max={240}
            step={1}
            value={videoFps}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v > 0) setVideoFps(v);
            }}
            style={S.fpsInput}
          />
        </div>
        <button style={S.iconBtn} onClick={() => zoom(1.5)} disabled={!mediaUrl}>
          <ZoomIn size={16} />
          拡大
        </button>
        <button
          style={S.iconBtn}
          onClick={() => zoom(1 / 1.5)}
          disabled={!mediaUrl}
        >
          <ZoomOut size={16} />
          縮小
        </button>
        <div style={S.divider} />
        {[0.1, 0.25, 0.5, 0.75, 1].map((r) => {
          const active = playbackRate === r;
          return (
            <button
              key={r}
              style={{
                ...S.iconBtn,
                ...(active
                  ? { borderColor: "#5ad1ff", color: "#5ad1ff" }
                  : {}),
              }}
              onClick={() => setPlaybackRate(r)}
              disabled={!mediaUrl}
              aria-pressed={active}
            >
              {r}x
            </button>
          );
        })}
        <div style={S.divider} />
        <button
          style={{ ...S.iconBtn, borderColor: "#3ddc84", color: "#3ddc84" }}
          onClick={() => setRegionStart(playhead)}
          disabled={!mediaUrl}
        >
          <FlagTriangleRight size={16} />
          開始を設定
        </button>
        <button
          style={{ ...S.iconBtn, borderColor: "#ff9d2e", color: "#ff9d2e" }}
          onClick={() => setRegionEnd(playhead)}
          disabled={!mediaUrl}
        >
          <FlagTriangleLeft size={16} />
          終了を設定
        </button>
        <button
          style={S.iconBtn}
          onClick={() => {
            setRegionStart(null);
            setRegionEnd(null);
          }}
          disabled={regionStart == null && regionEnd == null}
        >
          <RotateCcw size={16} />
          区間リセット
        </button>
      </div>

      <div style={S.controls}>
        <button
          style={{ ...S.iconBtn, borderColor: "#ff3b4e", color: "#ff7480" }}
          onClick={(e) => addMarkerAtPlayhead(e.shiftKey)}
          disabled={!mediaUrl}
          title="現在の再生位置にマーカーを追加 (M) / Shift+クリックで波形ピークにスナップ"
        >
          <MapPin size={16} />
          現在位置に追加
        </button>
        <button
          style={{ ...S.iconBtn, borderColor: "#ff3b4e", color: "#ff7480" }}
          onClick={removeMarkerAtPlayhead}
          disabled={!mediaUrl || markers.length === 0}
          title="現在の再生位置の近く (±100ms) のマーカーを削除 (D)"
        >
          <MapPinOff size={16} />
          現在位置を削除
        </button>
        <button
          style={{ ...S.iconBtn, borderColor: "#ff3b4e", color: "#ff7480" }}
          onClick={autoDetect}
          disabled={!waveform}
        >
          <Wand2 size={16} />
          自動検出
        </button>
        <div style={S.sliderGroup}>
          <span style={S.sliderLabel}>感度</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={sensitivity}
            onChange={(e) => setSensitivity(parseFloat(e.target.value))}
            style={S.slider}
          />
        </div>
        <button
          style={S.iconBtn}
          onClick={() => setMarkers([])}
          disabled={!markers.length}
        >
          <Trash2 size={16} />
          マーカー全消去
        </button>
      </div>

      {pitch && pitch.instant.length > 0 && (
        <div style={S.chartWrap}>
          <div style={S.chartTitle}>瞬間ピッチの推移(区間内・歩/秒)</div>
          <InstantChart instant={pitch.instant} />
        </div>
      )}

      {stepRows.length > 0 && (
        <div style={S.chartWrap}>
          <div style={S.chartTitle}>
            接地ごとのタイム(
            {regionStart != null ? "区間開始" : "1歩目"}からの累積 / 直前との差分)
            ・ 行クリックでそのマーカーへジャンプ
          </div>
          <StepsTable rows={stepRows} onJump={seek} playhead={playhead} />
        </div>
      )}

      <div style={S.footer}>
        <span style={S.hint}>
          空きをクリック=シーク / ダブルクリック=接地マーカー追加 /
          マーカーをドラッグ=移動 / マーカーをダブルクリック=削除 ・
          緑=開始 橙=終了の線もドラッグ可 ・ 波形は横ホイール/Shift+ホイールでスクロール ・
          Space=再生/停止 / ←→=コマ送り(Shiftで5f) / M=現在位置にマーカー(Shiftで波形ピークに吸着) / D=現在位置近くのマーカー削除
        </span>
        <span style={S.status}>{status}</span>
      </div>
      {fileName && <div style={S.fname}>file: {fileName}</div>}
    </div>
  );
}

function StepsTable({
  rows,
  onJump,
  playhead,
}: {
  rows: StepRow[];
  onJump: (t: number) => void;
  playhead: number;
}) {
  return (
    <div style={S.tableScroll}>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={{ ...S.th, textAlign: "left" }}>#</th>
            <th style={S.th}>時刻 (s)</th>
            <th style={S.th}>累積 (s)</th>
            <th style={S.th}>Δt (s)</th>
            <th style={S.th}>歩/秒</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // 再生ヘッドが ±100ms 以内ならその行を「現在行」として強調。
            // 100ms はマーカー削除と同じ tolerance。接地間隔の半分より小さければ
            // 一意に決まる。
            const isCurrent = Math.abs(r.t - playhead) < 0.1;
            return (
              <tr
                key={r.idx}
                className={`stepRow${isCurrent ? " current" : ""}`}
                onClick={() => onJump(r.t)}
              >
                <td style={{ ...S.td, textAlign: "left", color: "#7e818c" }}>
                  {r.idx}
                </td>
                <td style={S.td}>{r.t.toFixed(3)}</td>
                <td style={S.td}>{r.cum.toFixed(3)}</td>
                <td style={S.td}>{r.gap != null ? r.gap.toFixed(3) : "—"}</td>
                <td style={S.td}>{r.ips != null ? r.ips.toFixed(2) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function InstantChart({ instant }: { instant: number[] }) {
  const W = 100,
    H = 28;
  const min = Math.min(...instant),
    max = Math.max(...instant),
    range = max - min || 1;
  const pts = instant
    .map((v, i) => {
      const x = (i / Math.max(1, instant.length - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: 70 }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke="#5ad1ff"
        strokeWidth="0.6"
        vectorEffect="non-scaling-stroke"
      />
      {instant.map((v, i) => {
        const x = (i / Math.max(1, instant.length - 1)) * W;
        const y = H - ((v - min) / range) * H;
        return <circle key={i} cx={x} cy={y} r="0.9" fill="#ff3b4e" />;
      })}
    </svg>
  );
}

function Stat({
  label,
  value,
  unit,
  icon,
  big,
}: {
  label: string;
  value: string;
  unit: string;
  icon: ReactNode;
  big?: boolean;
}) {
  return (
    <div style={S.statCard}>
      <div style={S.statLabel}>
        {icon}
        {label}
      </div>
      <div style={S.statValRow}>
        <span style={{ ...S.statVal, fontSize: big ? 38 : 26 }}>{value}</span>
        <span style={S.statUnit}>{unit}</span>
      </div>
    </div>
  );
}

const mono = "'JetBrains Mono', ui-monospace, monospace";
const display = "'Oswald', sans-serif";

const S: Record<string, CSSProperties> = {
  root: { background: "#0c0d10", color: "#e8e8ea", fontFamily: mono, padding: 20, borderRadius: 14, minHeight: 600, border: "1px solid #1d1f25" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 },
  brand: { display: "flex", alignItems: "center", gap: 10 },
  title: { fontFamily: display, fontSize: 24, letterSpacing: 3, fontWeight: 700, color: "#fff" },
  sub: { fontSize: 11, color: "#6b6e78", letterSpacing: 1 },
  uploadBtn: { display: "flex", alignItems: "center", gap: 8, background: "#ff3b4e", color: "#fff", padding: "9px 16px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontWeight: 600, border: "none", fontFamily: mono },
  cards: { display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" },
  statCard: { flex: "1 1 130px", background: "#131419", border: "1px solid #20222a", borderRadius: 10, padding: "12px 14px" },
  statLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#7e818c", letterSpacing: 1, marginBottom: 6 },
  statValRow: { display: "flex", alignItems: "baseline", gap: 6 },
  statVal: { fontWeight: 800, color: "#fff", lineHeight: 1 },
  statUnit: { fontSize: 11, color: "#6b6e78" },
  stage: { display: "flex", flexDirection: "column", gap: 12, alignItems: "stretch" },
  video: { display: "block", margin: "0 auto", maxHeight: 480, maxWidth: "100%", background: "#000", borderRadius: 10, border: "1px solid #20222a", objectFit: "contain" },
  waveWrap: { position: "relative", width: "100%", minWidth: 320, background: "#08090b", border: "1px solid #20222a", borderRadius: 10, overflow: "hidden" },
  empty: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#4a4d57", fontSize: 13 },
  scrollbar: { width: "100%", marginTop: 8, accentColor: "#ff3b4e" },
  controls: { display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" },
  iconBtn: { display: "flex", alignItems: "center", gap: 6, background: "#16181e", color: "#d5d7dd", border: "1px solid #262932", padding: "8px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: mono },
  divider: { width: 1, height: 24, background: "#262932", margin: "0 4px" },
  sliderGroup: { display: "flex", alignItems: "center", gap: 8 },
  sliderLabel: { fontSize: 11, color: "#7e818c" },
  slider: { width: 110, accentColor: "#5ad1ff" },
  fpsInput: { width: 56, background: "#16181e", color: "#d5d7dd", border: "1px solid #262932", borderRadius: 6, padding: "4px 6px", fontFamily: mono, fontSize: 12, fontVariantNumeric: "tabular-nums" },
  timeBar: { display: "flex", justifyContent: "center", alignItems: "baseline", gap: 8, padding: "4px 0 6px", fontVariantNumeric: "tabular-nums" },
  timeNow: { fontFamily: mono, fontSize: 24, color: "#fff", fontWeight: 700, letterSpacing: 1 },
  timeSep: { color: "#3f424b", fontSize: 16 },
  timeTotal: { fontFamily: mono, fontSize: 12, color: "#7e818c" },
  chartWrap: { marginTop: 16, background: "#131419", border: "1px solid #20222a", borderRadius: 10, padding: "10px 14px" },
  chartTitle: { fontSize: 11, color: "#7e818c", letterSpacing: 1, marginBottom: 4 },
  tableScroll: { maxHeight: 260, overflowY: "auto", marginTop: 4 },
  table: { width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 12 },
  th: { textAlign: "right", padding: "4px 8px", color: "#7e818c", fontWeight: 500, fontSize: 11, letterSpacing: 0.5, borderBottom: "1px solid #20222a", position: "sticky", top: 0, background: "#131419" },
  td: { textAlign: "right", padding: "3px 8px", color: "#e8e8ea", borderBottom: "1px solid #1a1c22", fontVariantNumeric: "tabular-nums" },
  footer: { marginTop: 16, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  hint: { fontSize: 11, color: "#5a5d67", maxWidth: "62%" },
  status: { fontSize: 11, color: "#5ad1ff", textAlign: "right" },
  fname: { fontSize: 10, color: "#3f424b", marginTop: 6 },
};
