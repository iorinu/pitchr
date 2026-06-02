# PITCHR

陸上短距離の動画から **接地音を使ってピッチ (歩/秒) を解析する** アプリ。
React + TypeScript で UI を組み、**macOS デスクトップ版 (Tauri v2)** と **Web 版 (ブラウザ)**
の 2 つの動作モードを同一コードベースで提供する。

- デスクトップ版: ffmpeg sidecar で音声抽出（mp4 / mov / wav 等）
- Web 版: ブラウザの **WebCodecs** で mp4 を解析、失敗時は **ffmpeg.wasm** にフォールバック

## 機能

- 動画/音声を読み込み、波形を表示
- 動画と波形の同期再生（映像で接地を目視確認しながらマーカーを打つ）
- 波形上の接地マーカー操作:
  - 空きクリック = シーク
  - ダブルクリック = マーカー追加
  - マーカーをドラッグ = 移動
  - マーカーをダブルクリック = 削除
- 解析区間（開始 / 終了）の指定。区間外はマスクし、計算と自動検出は区間内のみ対象
- 自動検出（感度スライダー付き、エンベロープのフラックスでオンセット候補）
- ピッチを「歩/秒」で算出（接地1回=1歩）。平均・中央値・瞬間ピッチの推移を表示
- Web 版はドラッグ&ドロップでファイル読込にも対応

## 動作モードの違い

|  | デスクトップ版 (Tauri) | Web 版 (ブラウザ) |
| --- | --- | --- |
| 対応 OS | macOS (arm64) | Chromium / Safari 16.4+ |
| インストール | 必要 (`.app` 配布想定) | 不要 |
| 対応形式 | mp4 / mov / mkv / wav / mp3 / m4a / ... | **mp4 / wav / mp3 / m4a** |
| 音声抽出 | ffmpeg sidecar (Rust) | WebCodecs → ffmpeg.wasm fallback |
| ファイルの行き先 | ローカルのみ | ローカルのみ（外部送信なし） |

## 必要環境

### 共通

- Node.js 20+ と npm

### デスクトップ版 (Tauri) を動かす場合

- macOS (Apple Silicon, arm64)
- Rust toolchain (`rustup`)
- Homebrew の ffmpeg

```sh
brew install ffmpeg
```

### Web 版だけ動かす場合

- 上記の Rust / ffmpeg は不要、Node.js のみで OK

## 初回セットアップ

```sh
# 共通: JavaScript 依存
npm install
```

### デスクトップ版を使う場合

```sh
# ffmpeg sidecar を配置 (macOS arm64)
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

### デスクトップ版

```sh
npm run tauri dev
```

アプリが起動したら右上の「動画 / 音声を読込」から mp4 / mov / wav 等を選択する。

### Web 版

```sh
npm run dev
```

`http://localhost:1420/` をブラウザで開く。ファイル選択ボタン、またはウィンドウへの
D&D で mp4 / wav / mp3 / m4a を読み込む。

> Web 版は `Cross-Origin-Opener-Policy: same-origin` と
> `Cross-Origin-Embedder-Policy: require-corp` を返す必要があるため
> (ffmpeg.wasm の `SharedArrayBuffer` 要件)、`vite.config.ts` の dev サーバー設定と
> 本番用の `vercel.json` の両方でこれらのヘッダを付けている。

## デプロイ

Web 版は Vercel に自動デプロイされる。

- `main` への push → Production
- 任意のブランチへの push → Preview URL

`vercel.json` で COOP/COEP ヘッダと SPA fallback が設定済み。

## ディレクトリ構成

```
.
├── index.html
├── package.json
├── vite.config.ts            # Web 版 dev サーバー設定 (COOP/COEP)
├── vercel.json               # Vercel 本番ヘッダ + SPA rewrite
├── public/fonts/             # JetBrains Mono / Oswald (Variable woff2)
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── PitchAnalyzer.tsx     # UI とロジック (両モード共通)
│   ├── index.css             # @font-face とリセット
│   └── lib/
│       ├── platform.ts                # Tauri/Web 判定
│       ├── openMediaFile.ts           # ファイル選択の抽象化
│       ├── extractWaveform.ts         # 波形抽出のディスパッチャ
│       ├── extractWaveform.web.ts     # Web: WebCodecs (mp4box) + decodeAudioData
│       └── extractWaveform.ffmpeg.ts  # Web: ffmpeg.wasm フォールバック (jsDelivr)
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

## 波形抽出の流れ

### デスクトップ版 (Tauri)

1. フロントが `invoke('extract_waveform', { path })` で Rust に絶対パスを渡す
2. Rust が ffmpeg sidecar で `-vn -ac 1 -ar 44100 -f wav` のモノラル WAV に変換
3. `hound` で WAV をデコードし、`-1..+1` の `f32` 配列に正規化
4. `{ samples, sampleRate, duration }` をフロントに返す
5. フロントは Canvas 波形描画と `detectOnsets` にそのまま流し込む

ブラウザの `decodeAudioData` は mp4 動画の音声を読めないため、デスクトップ版では
ffmpeg 経路を必須にしている。

### Web 版 (ブラウザ)

拡張子で 2 つの経路に分岐する:

- **wav / mp3**: `AudioContext.decodeAudioData` で直接デコード
- **mp4 / m4a**:
  1. `MP4Box.js` で demux し、AAC の `AudioSpecificConfig` を取得
  2. `WebCodecs` の `AudioDecoder` で PCM 化（ブラウザ内蔵デコーダ使用、軽量）
  3. 失敗時は **ffmpeg.wasm** にフォールバック（core は jsDelivr から取得）

ffmpeg.wasm は初回ロードに約 25MB かかるため、WebCodecs が通る限りそちらを優先する。
動画ファイルそのものは一切外部に送信されない。

## 進め方メモ

- [x] 1. プロジェクト雛形 + フロント移植（デザイン維持）で「ファイルを開いて波形と動画が出る」まで
- [x] 2. `extract_waveform` を実装して mp4 でも波形が出るように
- [x] 3. 区間・マーカー・ピッチ算出・同期再生の通し動作確認
- [x] 4. Web 版（WebCodecs + ffmpeg.wasm フォールバック）の追加

将来:

- `requestVideoFrameCallback` での 60fps コマ送り（フレーム単位の接地合わせ）
- 描画用のダウンサンプル peak データ（長尺対応）
- touch / モバイル対応
- IndexedDB によるマーカー・解析区間の永続化（要セキュリティ判断）
