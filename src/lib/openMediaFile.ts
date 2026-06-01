import { isTauri } from "./platform";

// 動画/音声ファイル選択の抽象化。
// Tauri ではネイティブダイアログ + パス、ブラウザでは <input type="file"> + Blob URL。
//
// 返り値:
//   path     : Tauri 環境ではローカル絶対パス（Rust 側に渡せる）。Web では undefined。
//   srcUrl   : <video>/<audio> の src にそのまま入れる URL。
//   fileName : 表示用ファイル名。
//   blob     : Web 環境では File オブジェクト。Tauri では undefined。
export type PickedMedia = {
  path?: string;
  srcUrl: string;
  fileName: string;
  blob?: File;
};

export async function pickMediaFile(): Promise<PickedMedia | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "動画 / 音声",
          extensions: [
            "mp4", "mov", "m4v", "mkv", "webm", "avi",
            "wav", "mp3", "m4a", "aac", "flac", "ogg",
          ],
        },
      ],
    });
    if (!picked || typeof picked !== "string") return null;
    const fileName = picked.split(/[\\/]/).pop() || picked;
    return {
      path: picked,
      srcUrl: convertFileSrc(picked),
      fileName,
    };
  }

  // ブラウザフォールバック（Tauri が無い環境）。
  // Web 版で正式サポートするのは mp4/wav/mp3。
  // mov/HEVC はブラウザ互換性が悪いため accept から除外（ユーザーが選んだ場合は抽出時にエラーになる）。
  return await new Promise<PickedMedia | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4,audio/wav,audio/mpeg,audio/mp3,.mp4,.wav,.mp3";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      resolve({
        srcUrl: URL.createObjectURL(file),
        fileName: file.name,
        blob: file,
      });
    };
    input.click();
  });
}
