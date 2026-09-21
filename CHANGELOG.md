# Changelog

このファイルの更新は **必須** です。`packages/*/src` を変更する commit / PR は、必ず
`## Unreleased` に 1 行以上追加すること（`pnpm run check:changelog` と CI が検証する）。
リリース時は `Unreleased` を `## X.Y.Z - YYYY-MM-DD` に改名し、
`package.json` / `packages/released-app-dev-mcp/package.json` / `.claude-plugin/plugin.json` /
`src/index.ts` の version を揃えて上げる。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)。
見出しは `Added` / `Changed` / `Fixed` / `Removed` / `Docs` を使う。

## Unreleased

## 0.3.0 - 2026-09-22

### Added
- XcodeGen（`project.yml`）/ Tuist（`Project.swift`）を検出し、生成 workflow の `xcodebuild` 前に
  「Select Xcode → SPM cache → generator install → generate」を差し込む。`.xcodeproj` が無いときは
  spec の `name:` からプロジェクト名と scheme を推定する。
- managed ファイルに `# template-version: N` を付与。`setup_repository` に `overwrite_workflows` を追加し、
  1 行目 `(customized)` で再生成の対象外にできる。
- `doctor` に `ci_pr_trigger_missing`（PR trigger の漏れ）/ `workflow_edited`（手編集）/
  `release_branch_commits`（Candidate 上の prepare 以降のコミット一覧）を追加。
- `prepare_release --dry-run` が未コミットファイルを一覧表示。
- `sync_release` / `finish_hotfix` / `finish_release` が fix を取り込めていない `feature/*` を案内。
- `GITHUB_TOKEN` / `GH_TOKEN` が無いとき `gh auth token` にフォールバック。
- `pnpm run bundle` で単一ファイルのプラグイン用ビルド（`dist/index.mjs`）を生成。
- Claude Code プラグインとして読み込むための `.claude-plugin/plugin.json` / `.mcp.json`。

### Changed
- managed workflow がテンプレートと異なる場合、`setup_repository` は上書きせず報告する
  （`dry_run: true` で diff 表示、`overwrite_workflows: true` で置換）。`migrate_strategy` は従来通り置換する。
- `release/*` のうち semver（`release/X.Y.Z`）だけを Release Candidate として扱う。
- 全ツールの description 冒頭に副作用（READ-ONLY / MERGES, TAGS AND PUSHES 等）を明記。

### Fixed
- 生成 workflow が生成プロジェクトで `<App>.xcodeproj does not exist` と即失敗していた。
- `doctor` の案内どおり `setup_repository` を再実行すると手編集した workflow が消えていた。
- `get_app_status` が `release/build-41` のような無関係な branch を active release branch と報告していた。

## 0.2.0 - 2026-09-05

### Added
- `released-app-dev-mcp` として Small / Large の 2 Strategy を 1 サーバーに統合。
- `migrate_strategy`（small → large）、`doctor`、`.app-dev-mcp.json` による Strategy 固定。

## 0.1.0 - 2026-08-17

### Added
- `small-app-dev-mcp` v0.1 MVP。
