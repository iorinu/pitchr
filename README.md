# PITCHR

陸上短距離の動画から **接地音を使ってピッチ (歩/秒) を解析する** macOS デスクトップアプリ。
Tauri v2 + React + TypeScript で実装し、音声抽出は ffmpeg sidecar を利用する。

## 機能

- 動画/音声を読み込み、波形を表示
- 動画と波形の同期再生（映像で接地を目視確認しながらマーカーを打つ）
- 波形上の接地マーカー操作：
  - 空きクリック = シーク
  - ダブルクリック = マーカー追加
  - マーカーをドラッグ = 移動
  - マーカーをダブルクリック = 削除
- 解析区間（開始 / 終了）の指定。区間外はマスクし、計算と自動検出は区間内のみ対象
- 自動検出（感度スライダー付き、エンベロープのフラックスでオンセット候補）
- ピッチを「歩/秒」で算出（接地1回=1歩）。平均・中央値・瞬間ピッチの推移を表示

## 必要環境

- macOS (Apple Silicon, arm64)
- Node.js 20+ と npm
- Rust toolchain (`rustup`)
- Homebrew の ffmpeg

```sh
brew install ffmpeg
```

## 初回セットアップ

リポジトリを clone した後、

```sh
# 1) JavaScript 依存
npm install

# 2) ffmpeg sidecar を配置 (macOS arm64)
mkdir -p src-tauri/binaries
cp "$(brew --prefix ffmpeg)/bin/ffmpeg" src-tauri/binaries/ffmpeg-aarch64-apple-darwin
chmod +x src-tauri/binaries/ffmpeg-aarch64-apple-darwin
```

> sidecar のファイル名末尾は target triple に合わせる必要がある。Apple Silicon は
> `aarch64-apple-darwin`、Intel Mac は `x86_64-apple-darwin`。
>
> Homebrew の ffmpeg は動的リンクなので **開発用** に使う前提。配布バンドル
> (`npm run tauri build`) を作る際は static build (例: [evermeet.cx](https://evermeet.cx/ffmpeg/))
> に差し替えること。

## 開発起動

```sh
npm run tauri dev
```

アプリが起動したら右上の「動画 / 音声を読込」から mp4 / mov / wav 等を選択する。

## ディレクトリ構成

```
.
├── index.html
├── package.json
├── vite.config.ts
├── public/fonts/             # JetBrains Mono / Oswald (Variable woff2)
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── PitchAnalyzer.tsx     # UI とロジック (デザインは jsx プロトを完全踏襲)
│   ├── index.css             # @font-face とリセット
│   └── lib/
│       ├── platform.ts       # Tauri/Web 判定
│       ├── openMediaFile.ts  # ファイル選択の抽象化
│       └── extractWaveform.ts# 波形抽出の抽象化 (Tauri は invoke、Web は decodeAudioData)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       # externalBin に binaries/ffmpeg を登録
    ├── capabilities/default.json
    ├── binaries/             # ffmpeg-<triple> を配置 (Git 管理外)
    └── src/
        ├── main.rs
        ├── lib.rs            # extract_waveform コマンド
        └── waveform.rs       # WAV デコード (hound)
```

## extract_waveform の流れ

1. フロントが `invoke('extract_waveform', { path })` で Rust に絶対パスを渡す
2. Rust が ffmpeg sidecar で `-vn -ac 1 -ar 44100 -f wav` のモノラル WAV に変換
3. `hound` で WAV をデコードし、`-1..+1` の `f32` 配列に正規化
4. `{ samples, sampleRate, duration }` をフロントに返す
5. フロントは Canvas 波形描画と `detectOnsets` にそのまま流し込む

ブラウザの `decodeAudioData` は mp4 動画の音声を読めないため、この経路を必須にしている。

## 進め方メモ

- [x] 1. プロジェクト雛形 + フロント移植（デザイン維持）で「ファイルを開いて波形と動画が出る」まで
- [x] 2. `extract_waveform` を実装して mp4 でも波形が出るように
- [ ] 3. 区間・マーカー・ピッチ算出・同期再生の通し動作確認（実機で）

将来:

- `requestVideoFrameCallback` での 60fps コマ送り（フレーム単位の接地合わせ）
- 描画用のダウンサンプル peak データ（長尺対応）
- Web 版（ブラウザのみで動かす場合は wav/mp3 専用になる予定）
