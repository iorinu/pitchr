import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Upload, Play, Pause, ZoomIn, ZoomOut, Wand2, Trash2,
  Footprints, Activity, Gauge, Crosshair, FlagTriangleRight,
  FlagTriangleLeft, RotateCcw,
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
      const wf = await extractWaveform(picked);
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
  }, [waveform, markers, pxPerSec, scroll, playhead, viewW, regionStart, regionEnd]);

  useEffect(() => {
    draw();
  }, [draw]);
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
    const t = xToTime(e.clientX);
    const idx = nearestMarker(t);
    if (idx >= 0) setMarkers((m) => m.filter((_, i) => i !== idx));
    else setMarkers((m) => [...m, t].sort((a, b) => a - b)); // ダブルクリック=追加
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
  const maxScroll = Math.max(0, dur - viewW / pxPerSec);

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

        <div ref={wrapRef} style={S.waveWrap}>
          <canvas
            ref={canvasRef}
            style={{ display: "block", cursor: "crosshair" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onDoubleClick={onDoubleClick}
          />
          {!mediaUrl && (
            <div style={S.empty}>動画 or 音声ファイルを読み込んでください</div>
          )}
        </div>
      </div>

      {mediaUrl && maxScroll > 0 && (
        <input
          type="range"
          min={0}
          max={maxScroll}
          step={0.01}
          value={Math.min(scroll, maxScroll)}
          onChange={(e) => setScroll(parseFloat(e.target.value))}
          style={S.scrollbar}
        />
      )}

      <div style={S.controls}>
        <button style={S.iconBtn} onClick={togglePlay} disabled={!mediaUrl}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {playing ? "停止" : "再生"}
        </button>
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

      <div style={S.footer}>
        <span style={S.hint}>
          空きをクリック=シーク / ダブルクリック=接地マーカー追加 /
          マーカーをドラッグ=移動 / マーカーをダブルクリック=削除 ・
          緑=開始 橙=終了の線もドラッグ可
        </span>
        <span style={S.status}>{status}</span>
      </div>
      {fileName && <div style={S.fname}>file: {fileName}</div>}
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
  stage: { display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap" },
  video: { width: 280, maxHeight: 220, background: "#000", borderRadius: 10, border: "1px solid #20222a", objectFit: "contain" },
  waveWrap: { position: "relative", flex: "1 1 400px", minWidth: 320, background: "#08090b", border: "1px solid #20222a", borderRadius: 10, overflow: "hidden" },
  empty: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#4a4d57", fontSize: 13 },
  scrollbar: { width: "100%", marginTop: 8, accentColor: "#ff3b4e" },
  controls: { display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" },
  iconBtn: { display: "flex", alignItems: "center", gap: 6, background: "#16181e", color: "#d5d7dd", border: "1px solid #262932", padding: "8px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: mono },
  divider: { width: 1, height: 24, background: "#262932", margin: "0 4px" },
  sliderGroup: { display: "flex", alignItems: "center", gap: 8 },
  sliderLabel: { fontSize: 11, color: "#7e818c" },
  slider: { width: 110, accentColor: "#5ad1ff" },
  chartWrap: { marginTop: 16, background: "#131419", border: "1px solid #20222a", borderRadius: 10, padding: "10px 14px" },
  chartTitle: { fontSize: 11, color: "#7e818c", letterSpacing: 1, marginBottom: 4 },
  footer: { marginTop: 16, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  hint: { fontSize: 11, color: "#5a5d67", maxWidth: "62%" },
  status: { fontSize: 11, color: "#5ad1ff", textAlign: "right" },
  fname: { fontSize: 10, color: "#3f424b", marginTop: 6 },
};
