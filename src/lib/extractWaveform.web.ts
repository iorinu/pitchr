// Web 環境での波形抽出。
//
// 経路は 2 段階：
//   1. 軽い経路：AudioContext.decodeAudioData
//      - wav/mp3 など「ブラウザ単体で読めるもの」はこれで十分。
//   2. mp4 経路：MP4Box.js で demux → WebCodecs の AudioDecoder で PCM 化
//      - decodeAudioData は mp4 動画のオーディオトラックを読めない実装が多いため。
//      - ffmpeg.wasm より圧倒的に軽い（数MBの追加ロード無し、ネイティブデコーダ使用）。
//
// どちらも失敗したら呼び出し側 (extractWaveform.ts) で ffmpeg.wasm にフォールバックする。

import type { Waveform } from "./extractWaveform";

// AudioContext は Safari 旧版で webkit プレフィックス。
function getAudioCtx(): AudioContext {
  const Ctor =
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ?? window.AudioContext;
  return new Ctor();
}

// チャンネル平均でモノラル化（Tauri 版と同じ挙動）。
function toMono(channels: Float32Array[]): Float32Array {
  const ch = channels.length;
  const len = channels[0].length;
  const m = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = channels[c];
    for (let i = 0; i < len; i++) m[i] += d[i] / ch;
  }
  return m;
}

// ---- 1. decodeAudioData 経路 ---------------------------------------------

async function decodeWithAudioContext(file: File): Promise<Waveform> {
  const arr = await file.arrayBuffer();
  const ctx = getAudioCtx();
  const buf = await ctx.decodeAudioData(arr);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    channels.push(buf.getChannelData(c));
  }
  return {
    mono: toMono(channels),
    sampleRate: buf.sampleRate,
    duration: buf.duration,
  };
}

// ---- 2. MP4Box + WebCodecs 経路 ------------------------------------------

// MP4Box は track の codec config を Uint8Array で渡してくる必要がある。
// trak/mdia/minf/stbl/stsd の中の AudioSampleEntry に格納されている
// esds (AAC) や dOps (Opus) を取り出す。
//
// mp4box は trak エントリに直接 mdia 等のオブジェクトをぶら下げているので、
// それを辿って Box を直書きで Uint8Array に書き出す。
function buildAudioDescription(
  trak: any,
  DataStream: any,
): Uint8Array | undefined {
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;
  if (!entries || entries.length === 0) return undefined;
  const entry = entries[0];
  // AAC の場合 esds、Opus は dOps、FLAC は dfLa、ALAC は alac box が入っている。
  const box = entry.esds ?? entry.dOps ?? entry.dfLa ?? entry.alac;
  if (!box) return undefined;

  // mp4box の Box.write でシリアライズ → 先頭 8 バイト (size + type) を捨てる。
  // AudioDecoder.configure の description は box header を含めない生 payload を要求する。
  const ds = new DataStream();
  ds.endianness = DataStream.BIG_ENDIAN;
  box.write(ds);
  return new Uint8Array(ds.buffer, 8);
}

async function decodeMp4WithWebCodecs(file: File): Promise<Waveform> {
  if (typeof AudioDecoder === "undefined") {
    throw new Error("WebCodecs (AudioDecoder) 未対応のブラウザです");
  }

  // 動的 import：mp4box は ESM だがサイズが大きいので必要な時だけロード。
  const MP4BoxMod: any = await import("mp4box");
  const MP4Box = MP4BoxMod.default ?? MP4BoxMod;
  const DataStream = MP4BoxMod.DataStream ?? MP4BoxMod.default?.DataStream;

  const mp4 = MP4Box.createFile();

  return await new Promise<Waveform>((resolve, reject) => {
    let audioTrack: any | null = null;
    let decoder: AudioDecoder | null = null;
    let sampleRate = 0;
    let expectedSamples = 0;
    const chunks: Float32Array[][] = []; // [channel][frame] の塊
    let receivedFrames = 0;
    let allSamplesSent = false;

    const finish = () => {
      if (chunks.length === 0) {
        reject(new Error("音声フレームを 1 つも取得できませんでした"));
        return;
      }
      const numCh = chunks[0].length;
      // 各チャンネルを連結
      const merged: Float32Array[] = [];
      for (let c = 0; c < numCh; c++) {
        let total = 0;
        for (const f of chunks) total += f[c].length;
        const arr = new Float32Array(total);
        let off = 0;
        for (const f of chunks) {
          arr.set(f[c], off);
          off += f[c].length;
        }
        merged.push(arr);
      }
      const mono = toMono(merged);
      resolve({
        mono,
        sampleRate,
        duration: mono.length / sampleRate,
      });
    };

    mp4.onError = (e: unknown) => reject(new Error(`MP4 parse error: ${e}`));

    mp4.onReady = (info: any) => {
      const at = info.audioTracks?.[0];
      if (!at) {
        reject(new Error("音声トラックが見つかりません"));
        return;
      }
      audioTrack = at;
      sampleRate = at.audio?.sample_rate ?? 0;
      expectedSamples = at.nb_samples;

      // trak オブジェクトを mp4box から拾い、codec description を組み立てる
      const trak = mp4.getTrackById(at.id);
      const description = buildAudioDescription(trak, DataStream);

      decoder = new AudioDecoder({
        output: (frame: AudioData) => {
          const numCh = frame.numberOfChannels;
          const frameChannels: Float32Array[] = [];
          for (let c = 0; c < numCh; c++) {
            // f32-planar を要求して各チャンネルを別バッファに取り出す
            const size = frame.allocationSize({ planeIndex: c, format: "f32-planar" });
            const buf = new Float32Array(size / 4);
            frame.copyTo(buf, { planeIndex: c, format: "f32-planar" });
            frameChannels.push(buf);
          }
          chunks.push(frameChannels);
          receivedFrames += frame.numberOfFrames;
          frame.close();

          if (allSamplesSent && receivedFrames >= expectedSamples) {
            finish();
          }
        },
        error: (e) => reject(e),
      });

      decoder.configure({
        codec: at.codec,
        sampleRate,
        numberOfChannels: at.audio?.channel_count ?? 2,
        description,
      });

      mp4.setExtractionOptions(at.id, null, { nbSamples: 100 });
      mp4.start();
    };

    mp4.onSamples = (_id: number, _user: unknown, samples: any[]) => {
      if (!decoder || !audioTrack) return;
      for (const s of samples) {
        decoder.decode(
          new EncodedAudioChunk({
            type: s.is_sync ? "key" : "delta",
            // timescale はトラック固有。秒に直してマイクロ秒へ。
            timestamp: (s.cts * 1_000_000) / s.timescale,
            duration: (s.duration * 1_000_000) / s.timescale,
            data: s.data,
          })
        );
      }
    };

    // ファイル全体を一気に流し込む。
    file.arrayBuffer().then((ab) => {
      const buf = ab as ArrayBuffer & { fileStart?: number };
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();

      // flush() 後に最終 onSamples が来るので、decoder.flush でデコード完了を待つ。
      Promise.resolve().then(async () => {
        if (!decoder) return;
        await decoder.flush();
        allSamplesSent = true;
        if (receivedFrames >= expectedSamples) finish();
      });
    }).catch(reject);
  });
}

// ---- エントリポイント -----------------------------------------------------

export type ExtractProgress = (stage: string) => void;

export async function extractWaveformWeb(
  file: File,
  onProgress?: ExtractProgress,
): Promise<Waveform> {
  // mp4 系は decodeAudioData では読めないことが多いので先に WebCodecs を試す。
  const name = file.name.toLowerCase();
  const isMp4 =
    name.endsWith(".mp4") ||
    name.endsWith(".m4a") ||
    file.type.includes("mp4");

  if (isMp4) {
    try {
      onProgress?.("WebCodecs で mp4 をデコード中");
      return await decodeMp4WithWebCodecs(file);
    } catch (e) {
      console.warn("WebCodecs 経路が失敗、ffmpeg.wasm にフォールバック:", e);
      onProgress?.("ffmpeg.wasm をロード中（初回は時間がかかります）");
      const { extractWaveformFFmpeg } = await import("./extractWaveform.ffmpeg");
      return await extractWaveformFFmpeg(file, (m) => onProgress?.(`ffmpeg: ${m}`));
    }
  }

  // wav/mp3 などはまず decodeAudioData、失敗したら ffmpeg.wasm。
  try {
    onProgress?.("AudioContext でデコード中");
    return await decodeWithAudioContext(file);
  } catch (e) {
    console.warn("decodeAudioData が失敗、ffmpeg.wasm にフォールバック:", e);
    onProgress?.("ffmpeg.wasm をロード中（初回は時間がかかります）");
    const { extractWaveformFFmpeg } = await import("./extractWaveform.ffmpeg");
    return await extractWaveformFFmpeg(file, (m) => onProgress?.(`ffmpeg: ${m}`));
  }
}
