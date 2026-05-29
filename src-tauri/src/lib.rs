use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

mod waveform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![extract_waveform])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformPayload {
    samples: Vec<f32>,
    sample_rate: u32,
    duration: f64,
}

// 動画/音声ファイルから波形を抽出する。
// 1. ffmpeg sidecar で 44.1kHz モノラル 16bit PCM の WAV に変換（一時ファイル）
// 2. hound で WAV をデコードし、サンプルを -1..+1 の f32 に正規化
// 3. samples / sample_rate / duration をフロントに返す
//
// 注意: 長尺動画では samples が巨大になるが、まずは素の PCM を返す方針（プロト踏襲）。
//       描画用ダウンサンプルは将来検討する。
#[tauri::command]
async fn extract_waveform(
    app: AppHandle,
    path: String,
) -> Result<WaveformPayload, String> {
    let tmp_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("キャッシュディレクトリ取得失敗: {e}"))?;
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("キャッシュディレクトリ作成失敗: {e}"))?;

    // ファイル名衝突を避けるためタイムスタンプ付き wav にする
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let wav_path: PathBuf = tmp_dir.join(format!("pitchr_{stamp}.wav"));

    // ffmpeg sidecar 実行: -vn 映像無視 / -ac 1 モノラル / -ar 44100
    let sidecar = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar 取得失敗: {e}"))?;
    let output = sidecar
        .args([
            "-y",
            "-i",
            &path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-f",
            "wav",
            wav_path.to_str().ok_or("wav パスが UTF-8 でない")?,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg 実行失敗: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 一時ファイルが残っていれば消す
        let _ = std::fs::remove_file(&wav_path);
        return Err(format!(
            "ffmpeg がエラー終了 (code={:?}): {}",
            output.status.code(),
            stderr
        ));
    }

    // hound で wav をデコード
    let decoded = waveform::decode_wav(&wav_path)
        .map_err(|e| format!("WAV デコード失敗: {e}"));
    // 一時ファイルは用済み
    let _ = std::fs::remove_file(&wav_path);
    let (samples, sample_rate) = decoded?;
    let duration = if sample_rate > 0 {
        samples.len() as f64 / sample_rate as f64
    } else {
        0.0
    };
    Ok(WaveformPayload {
        samples,
        sample_rate,
        duration,
    })
}
