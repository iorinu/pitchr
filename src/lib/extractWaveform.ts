import { isTauri } from "./platform";
import type { PickedMedia } from "./openMediaFile";

// 波形抽出結果。`mono` はモノラル PCM (-1..+1)、`sampleRate` はサンプリングレート。
export type Waveform = {
  mono: Float32Array;
  sampleRate: number;
  duration: number;
};

// 入力ソース（Tauri ならファイルパス、Web なら File）から波形を取り出す。
// - Tauri: Rust 側 `extract_waveform` コマンド（ffmpeg sidecar 経由）を呼ぶ。
//          ブラウザの decodeAudioData は mp4 動画の音声を読めないことが多いため。
// - Web:   AudioContext.decodeAudioData にそのまま流す（wav/mp3 のみ実用）。
export async function extractWaveform(picked: PickedMedia): Promise<Waveform> {
  if (isTauri && picked.path) {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke<{
      samples: number[];
      sampleRate: number;
      duration: number;
    }>("extract_waveform", { path: picked.path });
    return {
      mono: Float32Array.from(res.samples),
      sampleRate: res.sampleRate,
      duration: res.duration,
    };
  }

  if (!picked.blob) {
    throw new Error("Web 環境では File 経由でしか波形を読めません");
  }
  const arr = await picked.blob.arrayBuffer();
  const Ctor =
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ?? window.AudioContext;
  const ctx = new Ctor();
  const buf = await ctx.decodeAudioData(arr);
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const m = new Float32Array(len);
  // チャンネル平均でモノラル化（プロトと同じ挙動）。
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) m[i] += d[i] / ch;
  }
  return { mono: m, sampleRate: buf.sampleRate, duration: buf.duration };
}
