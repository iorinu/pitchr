use std::path::Path;

// WAV を読み、モノラル f32 サンプル列 (-1..+1) と sample_rate を返す。
// マルチチャンネルなら平均でモノラル化（プロトと同じ挙動）。
pub fn decode_wav(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("open: {e}"))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    if channels == 0 {
        return Err("チャンネル数が 0".into());
    }
    let sample_rate = spec.sample_rate;
    let bits = spec.bits_per_sample;

    // インターリーブされたサンプルを取得し、チャンネル平均でモノラルに畳む。
    // ffmpeg 側で -ac 1 を指定しているので通常 channels=1 のはずだが、
    // 念のため一般化しておく（将来 ac 指定を外す可能性）。
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            // i32 として読み、ビット幅で正規化
            let max = (1i64 << (bits - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("sample read: {e}"))?
        }
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("sample read: {e}"))?,
    };

    if channels == 1 {
        return Ok((interleaved, sample_rate));
    }

    let frames = interleaved.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += interleaved[f * channels + c];
        }
        mono.push(sum / channels as f32);
    }
    Ok((mono, sample_rate))
}
