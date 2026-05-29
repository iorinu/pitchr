// プラットフォーム判定（Tauri 環境かブラウザかを切り分ける）
// 理由: 「まず Mac 用 Tauri、最終的に Web」という要件に備え、
//       UI ロジックを 1 本に保つために I/O 部分だけ抽象化したい。

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
