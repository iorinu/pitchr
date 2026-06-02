// ffmpeg.wasm を使った最終フォールバック。
//
// WebCodecs が無いブラウザ、または mp4 のコーデックが対応外（HEVC + ALAC など）で
// 失敗したときにここに来る。
//
// ffmpeg core (約 25MB) を CDN から取得して WebAssembly でデコードするため、
// 初回ロードに時間がかかる点に注意。COOP/COEP ヘッダが必須（SharedArrayBuffer）。

import type { Waveform } from "./extractWaveform";

// ffmpeg core (wasm + worker) は CDN から取得。
// unpkg は CORS ヘッダを返さないケースがあるので jsDelivr を使う。
// バージョンを固定して再現性を確保。
const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let ffmpegInstance: any | null = null;
let loading: Promise<any> | null = null;

async function getFFmpeg(onProgress?: (msg: string) => void) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loading) return loading;

  loading = (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { toBlobURL } = await import("@ffmpeg/util");
    const ff = new FFmpeg();
    if (onProgress) {
      ff.on("log", ({ message }: { message: string }) => onProgress(message));
    }
    // wasm/worker を CORS 可能な Blob URL に詰め替えてから load する。
    // unpkg から直接読むと CORP の制約で弾かれることがあるため。
    const coreURL = await toBlobURL(
      `${CORE_BASE}/ffmpeg-core.js`,
      "text/javascript",
    );
    const wasmURL = await toBlobURL(
      `${CORE_BASE}/ffmpeg-core.wasm`,
      "application/wasm",
    );
    const workerURL = await toBlobURL(
      `${CORE_BASE}/ffmpeg-core.worker.js`,
      "text/javascript",
    );
    await ff.load({ coreURL, wasmURL, workerURL });
    ffmpegInstance = ff;
    return ff;
  })();

  try {
    return await loading;
  } catch (e) {
    // 失敗時は loading をクリアして次回呼び出しで再試行できるようにする。
    // クリアしないと、ネットワーク瞬断や CDN の一時障害で 1 回失敗しただけで
    // ページをリロードしないと永久に ffmpeg.wasm が使えなくなる。
    loading = null;
    throw e;
  }
}

export async function extractWaveformFFmpeg(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<Waveform> {
  const ff = await getFFmpeg(onProgress);
  const inputName = "input." + (file.name.split(".").pop() || "bin");
  const outputName = "out.wav";

  // 仮想 FS に書き込み
  await ff.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
  // モノラル / 44.1kHz の wav に変換（Tauri 版の Rust 実装と同じ条件）。
  await ff.exec([
    "-i", inputName,
    "-vn",
    "-ac", "1",
    "-ar", "44100",
    "-f", "wav",
    outputName,
  ]);
  const data = await ff.readFile(outputName);
  const wavBuf = (data as Uint8Array).buffer;

  // ブラウザの AudioContext で wav をデコードしてサンプルを取り出す。
  const Ctor =
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ?? window.AudioContext;
  const ctx = new Ctor();
  const audio = await ctx.decodeAudioData(wavBuf.slice(0));
  const mono = audio.getChannelData(0).slice(); // 1ch
  return {
    mono: new Float32Array(mono),
    sampleRate: audio.sampleRate,
    duration: audio.duration,
  };
}
