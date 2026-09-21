# Agent Instructions

## This repository

`released-app-dev-mcp`（旧 `small-app-dev-mcp`）の実装リポジトリ。
Small / Large の 2 Strategy を 1 つの MCP サーバー内に持つ。

- Strategy 固有の分岐は `src/strategies/` にのみ置く。
  `if (strategy === 'small')` をツールや Core に散らさないこと。
- Git / GitHub の low-level 実装は `packages/git-core` と `src/core/` に集約する。
- 変更後は `pnpm run build && pnpm run test`（Node 22+ / Git 2.38+）。

### アップデート情報の更新は必須

`packages/*/src` を変更したら、**同じ commit / PR で** [CHANGELOG.md](CHANGELOG.md) の
`## Unreleased` に何を変えたかを書く。書き忘れは `pnpm run test`（`check:changelog`）と CI が落とす。

- 見出しは `Added` / `Changed` / `Fixed` / `Removed` / `Docs`。利用者視点で 1 行ずつ。
- ツールの挙動・引数・description・生成 workflow の内容が変わったら必ず対象。
- リリース（プラグイン再アップロード・tag）時は `Unreleased` を `## X.Y.Z - YYYY-MM-DD` に改名し、
  次の 4 箇所の version を同じ値に上げる:
  `package.json` / `packages/released-app-dev-mcp/package.json` /
  `.claude-plugin/plugin.json` / `packages/released-app-dev-mcp/src/index.ts`
- プラグイン配布用バンドルは `pnpm --filter released-app-dev-mcp run bundle`（`dist/index.mjs`）。

## When working in a RELEASED iOS app repository

このセクションは、この MCP を **利用する側**（App Store 公開済み iOS アプリ）の作業に適用される。

1. 最初に必ず `get_app_status` を呼ぶ。
2. `lifecycle = released` なのに `.app-dev-mcp.json` が無ければ `setup_repository` を最優先。
3. 次の操作は必ず MCP 経由で行う:
   release 開始 / release PR / release 完了 / hotfix 開始 / hotfix 完了 /
   production merge / tag 作成 / strategy migration
4. 次を通常の `git` コマンドで直接行ってはならない:
   `main` への direct push / production tag 作成 / release branch 作成 /
   hotfix branch 作成 / release merge / branch strategy 変更
5. MCP が使えない場合、通常の Git 運用へ fallback しない。
   MCP が利用不能であること・必要だった操作・未実行の処理を報告し、production 系操作を停止する。
   コード編集やテスト実行は続行してよい。
6. **リリース / hotfix の前に、そのバージョンのアップデート情報（App Store "What's New"）を書く。**
   `.appstore/<locale>/whats_new.txt` を利用者向けの言葉で更新し、出荷する branch に commit する。
   `prepare_release` / `finish_release` / `finish_hotfix` は未記載だと停止する。
   「Bug fixes and improvements」だけで済ませない。`release.requireReleaseNotes: false` を
   勝手に設定して回避しない。

未公開アプリ（`lifecycle = development`）にはこの Policy を強制しない。
初回 App Store Release 完了時点で `setup_repository` により管理下へ移行する。

詳細は [README.md](README.md) を参照。
