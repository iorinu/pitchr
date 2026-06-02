// 軽量 i18n。
// - 言語: ja / en の 2 種
// - 初期値: localStorage > navigator.language の順で決定
// - 切り替え: setLocale で全 useT/useLocale 利用箇所に反映
//
// なぜ Context ではなく外部ストア (useSyncExternalStore) かというと、
// このアプリは単一画面構成で Provider を置く意味が薄く、ライブラリ的に
// 「どこからでも import して呼ぶ」形のほうが書き換えが楽だから。
import { useSyncExternalStore } from "react";

export type Locale = "ja" | "en";

const STORAGE_KEY = "pitchr.locale";

// 初期ロケール判定。SSR は無いが念のため window をガード。
function detectInitial(): Locale {
  if (typeof window === "undefined") return "ja";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    // localStorage が無効でも続行する
  }
  const nav = (navigator.language || "").toLowerCase();
  return nav.startsWith("ja") ? "ja" : "en";
}

let currentLocale: Locale = detectInitial();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(l: Locale) {
  if (l === currentLocale) return;
  currentLocale = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // 失敗してもメモリ上では切り替わっているので無視
  }
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// React コンポーネントから現在ロケールと setter を取る。
export function useLocale(): [Locale, (l: Locale) => void] {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return [locale, setLocale];
}

// ---- 辞書 ----
// キーはドット区切りでカテゴリ分け。{var} で変数差し込み。
const dict = {
  ja: {
    "app.subtitle": "接地音ピッチ解析",
    "tab.analyze": "解析",
    "tab.help": "使い方",
    "btn.openFile": "動画 / 音声を読込",
    "drop.overlay": "ここにドロップして読み込む",

    "stats.avgPitch": "平均ピッチ",
    "stats.median": "中央値",
    "stats.stepCount": "接地数(区間内)",
    "stats.regionLen": "区間長",
    "unit.ips": "歩/秒",
    "unit.step": "歩",
    "unit.sec": "秒",

    "canvas.noWaveform": "波形なし(動画は再生できます)",
    "canvas.loadPrompt": "動画 or 音声ファイルを読み込んでください",

    "ctrl.play": "再生",
    "ctrl.pause": "停止",
    "ctrl.back1f": "−1f",
    "ctrl.fwd1f": "+1f",
    "ctrl.back1fTitle": "1フレーム戻す (←) / Shift+← で5フレーム",
    "ctrl.fwd1fTitle": "1フレーム進める (→) / Shift+→ で5フレーム",
    "ctrl.zoomIn": "拡大",
    "ctrl.zoomOut": "縮小",
    "ctrl.setStart": "開始を設定",
    "ctrl.setEnd": "終了を設定",
    "ctrl.resetRegion": "区間リセット",
    "ctrl.addAtPlayhead": "現在位置に追加",
    "ctrl.removeAtPlayhead": "現在位置を削除",
    "ctrl.addTitle":
      "現在の再生位置にマーカーを追加 (M) / Shift+クリックで波形ピークにスナップ",
    "ctrl.removeTitle": "現在の再生位置の近く (±100ms) のマーカーを削除 (D)",
    "ctrl.autoDetect": "自動検出",
    "ctrl.sensitivity": "感度",
    "ctrl.clearMarkers": "マーカー全消去",
    "ctrl.fps": "fps",

    "chart.instantTitle": "瞬間ピッチの推移(区間内・歩/秒)",
    "chart.stepsTitle":
      "接地ごとのタイム({base}からの累積 / 直前との差分) ・ 行クリックでそのマーカーへジャンプ",
    "chart.baseRegionStart": "区間開始",
    "chart.baseFirstStep": "1歩目",
    "table.time": "時刻 (s)",
    "table.cum": "累積 (s)",
    "table.delta": "Δt (s)",
    "table.ips": "歩/秒",

    "status.extracting": "波形抽出中...",
    "status.extractingStage": "波形抽出中: {stage}",
    "status.loaded": "読込完了 ({duration}s / {sampleRate}Hz)",
    "status.extractFailed":
      "波形抽出失敗(動画は再生可): {detail}\n別の形式 (mp4/wav/mp3) を試してください。",
    "status.unsupportedFormat":
      "この形式は波形抽出に対応していません (Web 版が対応するのは mp4 / wav / mp3 / m4a)。動画再生のみ可能です。",
    "status.picking": "ファイル選択中...",
    "status.pickCanceled": "ファイル選択キャンセル / エラー",
    "status.autoDetected": "自動検出: {count} 個",
    "status.noMarkerNear": "再生位置の近く (±100ms) にマーカーがありません",

    "footer.hint":
      "空きをクリック=シーク / ダブルクリック=接地マーカー追加 / マーカーをドラッグ=移動 / マーカーをダブルクリック=削除 ・ 緑=開始 橙=終了の線もドラッグ可 ・ 波形は横ホイール/Shift+ホイールでスクロール ・ Space=再生/停止 / ←→=コマ送り(Shiftで5f) / M=現在位置にマーカー(Shiftで波形ピークに吸着) / D=現在位置近くのマーカー削除",
    "aria.seek": "再生位置",
    "file.label": "file: {name}",
    "lang.label": "Lang",
  },
  en: {
    "app.subtitle": "Foot-strike pitch analyzer",
    "tab.analyze": "Analyze",
    "tab.help": "How to use",
    "btn.openFile": "Open video / audio",
    "drop.overlay": "Drop here to load",

    "stats.avgPitch": "Average pitch",
    "stats.median": "Median",
    "stats.stepCount": "Step count (in region)",
    "stats.regionLen": "Region length",
    "unit.ips": "steps/s",
    "unit.step": "steps",
    "unit.sec": "s",

    "canvas.noWaveform": "No waveform (video can still play)",
    "canvas.loadPrompt": "Load a video or audio file",

    "ctrl.play": "Play",
    "ctrl.pause": "Pause",
    "ctrl.back1f": "−1f",
    "ctrl.fwd1f": "+1f",
    "ctrl.back1fTitle": "Step back 1 frame (←) / Shift+← for 5 frames",
    "ctrl.fwd1fTitle": "Step forward 1 frame (→) / Shift+→ for 5 frames",
    "ctrl.zoomIn": "Zoom in",
    "ctrl.zoomOut": "Zoom out",
    "ctrl.setStart": "Set start",
    "ctrl.setEnd": "Set end",
    "ctrl.resetRegion": "Reset region",
    "ctrl.addAtPlayhead": "Add at playhead",
    "ctrl.removeAtPlayhead": "Remove at playhead",
    "ctrl.addTitle":
      "Add a marker at the current playhead (M) / Shift+click to snap to waveform peak",
    "ctrl.removeTitle":
      "Remove the nearest marker (within ±100ms) to the playhead (D)",
    "ctrl.autoDetect": "Auto detect",
    "ctrl.sensitivity": "Sensitivity",
    "ctrl.clearMarkers": "Clear markers",
    "ctrl.fps": "fps",

    "chart.instantTitle": "Instant pitch over time (in region, steps/s)",
    "chart.stepsTitle":
      "Per-step times (cumulative from {base} / delta from previous) · click a row to jump",
    "chart.baseRegionStart": "region start",
    "chart.baseFirstStep": "1st step",
    "table.time": "Time (s)",
    "table.cum": "Cumulative (s)",
    "table.delta": "Δt (s)",
    "table.ips": "steps/s",

    "status.extracting": "Extracting waveform...",
    "status.extractingStage": "Extracting waveform: {stage}",
    "status.loaded": "Loaded ({duration}s / {sampleRate}Hz)",
    "status.extractFailed":
      "Waveform extraction failed (video still plays): {detail}\nTry another format (mp4/wav/mp3).",
    "status.unsupportedFormat":
      "This format is not supported for waveform extraction (web supports mp4 / wav / mp3 / m4a). Only video playback is available.",
    "status.picking": "Selecting file...",
    "status.pickCanceled": "File selection canceled / error",
    "status.autoDetected": "Auto detect: {count}",
    "status.noMarkerNear": "No marker near the playhead (within ±100ms)",

    "footer.hint":
      "Click empty area = seek / double-click = add marker / drag marker = move / double-click marker = remove · Green = start, Orange = end (lines are draggable) · Scroll horizontally / Shift+wheel to scroll the waveform · Space = play/pause / ←→ = step frame (Shift for 5f) / M = add marker (Shift to snap to peak) / D = remove nearest marker",
    "aria.seek": "Playback position",
    "file.label": "file: {name}",
    "lang.label": "Lang",
  },
} as const;

export type TKey = keyof typeof dict.ja;

function interpolate(s: string, vars?: Record<string, string | number>) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

// React コンポーネントから翻訳関数を取る。
// ロケール変更時に再レンダーされるよう useLocale をフックする。
export function useT() {
  const [locale] = useLocale();
  return (key: TKey, vars?: Record<string, string | number>) => {
    const s = dict[locale][key] ?? dict.ja[key] ?? key;
    return interpolate(s, vars);
  };
}

// React 外 (例: コールバック / canvas 描画関数の中) で使う場合用。
// こちらはロケール変更を購読しないので、利用側で別途リレンダーを促す必要がある。
export function t(key: TKey, vars?: Record<string, string | number>) {
  const s = dict[currentLocale][key] ?? dict.ja[key] ?? key;
  return interpolate(s, vars);
}
