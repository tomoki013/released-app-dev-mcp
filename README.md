# small-app-dev-mcp

小規模・個人開発のiOSアプリ向けに、Git / GitHub / GitHub Actions / リリース運用を
安全かつ簡単に扱うための MCP サーバー。

**このMCPは「Git操作を増やすためのMCP」ではなく、「小規模アプリを安全にリリースするためのMCP」である。**
Gitコマンドをそのまま公開するラッパーではなく、`prepare_release` や `start_hotfix` のように
意味のある操作単位だけを Tool として公開する。develop branch・複数release branch・必須Review・
CODEOWNERSといった大規模チーム向けGit Flowは対象外。1人〜数人で1本のアプリを継続的に
アップデートするプロジェクト専用。

## 構成

```text
packages/
├── git-core/            # Git / GitHub / PR / Actions / project-detection / validation の共通ライブラリ
└── small-app-dev-mcp/   # MCPサーバー本体（v0.1 MVP）
```

`git-core` は低レベル実装（Git操作・GitHub APIクライアント・PR/Actions取得・iOSプロジェクト自動検出）
を切り出しており、将来 `team-app-dev-mcp` のような大規模チーム向けMCPからも再利用できる。

## ブランチモデル

```text
main        常にリリース可能な正式版。直接pushしない。
release     次回リリース用の変更を蓄積する常設ブランチ。通常開発はここで行う。
hotfix/*    公開中バージョンの重大バグを緊急修正するときだけ、mainから作成する。
```

## Installation

Node / pnpm のバージョンは [mise](https://mise.jdx.dev/)（`.mise.toml`）で固定している。

```bash
mise install     # .mise.toml が指定する node / pnpm を導入
pnpm install      # pnpm-workspace.yaml 経由でworkspace一括install
pnpm run build     # 各パッケージをビルド (pnpm -r --if-present run build)
```

## 対象リポジトリ

MCPサーバーは、**対象アプリのリポジトリをworking directoryとして**、または
`APP_DEV_PROJECT_DIR` 環境変数でそのパスを指定して起動する前提。1つのMCPサーバープロセスは
1つのアプリリポジトリだけを扱う。

```bash
export APP_DEV_PROJECT_DIR=/path/to/your/ios-app
```

## GitHub Token

```bash
export GITHUB_TOKEN=ghp_xxx   # repo スコープが必要
```

`GITHUB_TOKEN`（または `GH_TOKEN`）が未設定でもMCPサーバー自体は起動する。`get_app_status` /
`prepare_release` / `start_hotfix` / `sync_release` などローカルGit操作だけで完結するToolは
そのまま使え、CI状態確認・PR作成・branch protectionなどGitHub APIが必要な処理だけ
`GITHUB_TOKEN not set` を返す。

## MCP設定例

Claude Code など stdio 対応のMCPクライアントから、以下のように登録する。

```json
{
  "mcpServers": {
    "small-app-dev": {
      "command": "node",
      "args": ["/path/to/small-app-dev-mcp/packages/small-app-dev-mcp/dist/index.js"],
      "env": {
        "APP_DEV_PROJECT_DIR": "/path/to/your/ios-app",
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

対象プロジェクトのルートに `.appdev.yml` が無ければ、`setup_repository` が作成する（自動検出できる
項目は省略可能）。

## `.appdev.yml`

```yaml
version: 1

project:
  type: ios
  # 自動検出できる場合は省略可能
  # path: Yohaku.xcodeproj / Yohaku.xcworkspace
  # scheme: Yohaku

workflow:
  production_branch: main
  development_branch: release
  hotfix_prefix: hotfix/

branches:
  direct_commit:
    main: false
    release: true

release:
  merge_strategy: squash
  require:
    clean_worktree: true
    ci: true
  auto_submit_review: false
  auto_publish: false

hotfix:
  base_branch: main
  sync_back_to_release: true

github:
  require_pull_request_to_main: true
  block_force_push_main: true
```

設定の優先順位は **`.appdev.yml` の明示指定 > 自動検出 > default** の順。`project.path` /
`project.scheme` を書けば、xcworkspace/xcodeprojやscheme選択があいまいな場合でも上書きできる。

## v0.1 MVP Tools

| Tool | 概要 |
| --- | --- |
| `get_app_status` | プロジェクト情報・ブランチ・working tree・CI・Release PR・Hotfix状態をまとめて確認する |
| `setup_repository` | `.appdev.yml`・releaseブランチ・CI/Release workflow・PRテンプレート・main branch protectionを作成する（冪等） |
| `prepare_release` | 指定バージョンがリリース可能な状態かをチェックリストで確認する |
| `create_release_pr` | `release → main` のPRを、コミットから自動生成した概要付きで作成する（重複作成しない） |
| `start_hotfix` | `main` から `hotfix/<name>` ブランチを作成する（名前は自動でslug化） |
| `finish_hotfix` | Hotfixの状態を確認し、`hotfix/<name> → main` のPRを作成する（既存PRがあれば再利用） |
| `sync_release` | Hotfix後などに `main` の変更を `release` へマージ・pushする（衝突時は自動解決しない） |

`setup_repository` / `create_release_pr` / `start_hotfix` / `finish_hotfix` / `sync_release` は
`dry_run: true` で「何をするか」のプレビューのみ表示できる。

`setup_repository` が設定する `main` の branch protection:

- Require pull request before merging: `true`
- Required approving reviews: `0`（PRは必須だが、他者レビューは必須にしない — 小規模/個人開発では
  レビュワーがいないことが多いため。「PRを必須にすること」と「レビューを必須にすること」は別設定）
- Require status checks: `true`
- Allow force pushes: `false`
- Allow deletions: `false`

## 基本運用フロー

```text
setup_repository
↓
main / release 運用をセットアップ
↓
普段は release で開発
↓
get_app_status
↓
prepare_release
↓
create_release_pr
↓
release → main を merge
↓
GitHub Actions Release workflow
```

## Hotfixフロー

```text
main
↓
start_hotfix(name: "startup crash")   →  hotfix/startup-crash
↓
修正をcommit
↓
finish_hotfix(name: "startup crash")  →  hotfix/startup-crash → main のPR
↓
merge → Release workflow発火
↓
sync_release                          →  main の変更を release へ同期
```

`get_app_status` と `prepare_release` は、Hotfixがmainへmergeされた後に `release` へ未同期の
場合、常に警告を出す（`sync_release` の実行を促す）。

## 意図的にやらないこと

- `main` への直接push・force push・branch削除（Tool内部でも一切使用しない）
- App Store / Google Play への自動submit・自動公開（GitHub側の準備が整うところまでで停止する）
- App Store Description・Screenshots・Privacy・IAP・Review submissionの管理（`appstore-connect-mcp` 側の責務）
- develop branch、複数release branch、必須Review、CODEOWNERSなど大規模チーム向け運用
- Android / Flutter / React Native対応、AI Release Notes、UI Dashboard、multi-user・organization管理

これらは仕様書のスコープ外であり、必要になれば別の `team-app-dev-mcp` として実装する。

## GitHub Actions の動作

- **CI (`ci.yml`)**: `main` へのPR、および `release` へのpushで発火。Checkout → Build のみ（v0.1では
  テスト実行は行わない）。目的は壊れたコードがmainへ入るのを防ぐこと。
- **Release (`release.yml`)**: `main` へのPRがmergeされ、かつマージされたブランチが
  `release` または `hotfix/*` の場合のみ発火（`feature/*`・`chore/*`・`docs/*` などの通常マージは
  対象外）。Checkout → Build → Archive可能状態の確認 → Release preparation summary の出力で停止する。
  実際の審査提出・公開は行わない。

`setup_repository` が生成する `ci.yml` / `release.yml` は、検出できたXcodeプロジェクト/schemeを
埋め込んだ状態で生成される。プロジェクト/schemeを自動検出できない場合はプレースホルダー入りの
workflowを書かず、生成をスキップして `.appdev.yml` への手動指定を促す。

## 既知の制約 (v0.1)

- iOS + GitHub のみを想定
- CI workflow はビルドのみ（テストターゲットの自動検出・実行は行わない）
- `run_preflight` / `check_ci` / `generate_release_notes` などはv0.2以降
- App Store Connect 側の操作（Version作成・Submit等）はスコープ外。別MCP (`appstore-connect-mcp`) と組み合わせて使う想定
