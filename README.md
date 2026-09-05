# Released App Development MCP

App Store へ**一度でも正式公開された** iOS アプリの Git / GitHub / GitHub Actions / リリース運用を
統括する MCP サーバー。パッケージ名は `released-app-dev-mcp`（旧 `small-app-dev-mcp`）。

**これは「Git 操作を増やすための MCP」ではなく、「公開済みアプリを壊さずにリリースするための MCP」である。**
`git` をそのまま公開するラッパーではなく、`prepare_release` / `finish_release` / `start_hotfix` のように
意味のある操作単位だけを Tool として公開する。

公開済みアプリの Release Git Policy の正本は、アプリごとの独自フローではなく **この MCP** とする。

---

## Released App Policy（最重要）

- App Store へ一度でも正式公開されたアプリでは、**Git のリリース運用に必ずこの MCP を使う。**
- 公開済みアプリでは、通常の `git` コマンドで **production branch / release branch / hotfix branch /
  release tag を直接操作してはならない。**
- 特に以下は MCP 必須:
  release 開始 / release PR / release 完了 / hotfix 開始 / hotfix 完了 / production merge /
  tag 作成 / strategy migration
- 「Released」の定義は **App Store Production への公開が最低 1 回あること**。
  TestFlight 配布のみは `unreleased` とする。

```text
development
   ↓
first App Store release
   ↓
released  →  setup_repository で本 MCP 管理下へ
   ↓
Released App Development MCP mandatory
```

### MCP が使えないとき

公開済みアプリで本 MCP が利用できない場合、**通常の Git 運用へ勝手に fallback してはならない。**
「MCP が使えなかったので git で main に merge しました」は禁止。

その場合は次を報告して production 系操作を停止する。

1. MCP が利用不能であること
2. 本来必要だった Git 操作
3. 実行できていない処理

通常のソースコード編集・テスト実行までは継続してよい。

---

## 2 つの Strategy

Small / Large で別サーバーは作らず、共通 Core の上に Strategy として共存させる。

```text
Released App Development MCP
│
├── Common Core   … Git / GitHub / Repository / Config / Release / Validation
├── Small Strategy
└── Large Strategy
```

| 項目 | Small | Large |
| --- | --- | --- |
| Production | `main` | `main` |
| 公開版の確定 | tag `vX.Y.Z` | tag `vX.Y.Z` |
| 通常開発 | `release` | `develop` |
| Release Candidate | `release` | `release/X.Y.Z` |
| feature | `feature/*` → `release` | `feature/*` → `develop` |
| hotfix source | `main` | `main` |
| hotfix sync | `release` | `develop` + 進行中の `release/*` |
| 常設 branch | `main` / `release` | `main` / `develop` |
| 一時 release branch | 不要 | 必要 |

### Small の用途

小〜中規模 / 1 人開発中心 / feature 間依存が小さい / backend 依存が小さい /
migration リスクが小さい / Release Candidate を長期間維持しなくてよい。

### Large の用途

Backend あり / CloudKit 等の共有データ / DB migration / 課金状態 / ユーザー間共有 /
複数 feature 並行 / backward compatibility 重視 / Release Candidate 検証期間が必要。

---

## Branch 図

### Small

```text
feature/*
    │
    ▼
 release ────────────────┐
    │                    │  ← 次期リリース開発ライン兼 Release Candidate
    ├─ CI                │
    ├─ Release Validation│
    ▼                    │
App Store Release        │
    │                    │
    ▼                    │
   main ◀────────────────┘
    │
    └─ vX.Y.Z
```

Small の hotfix:

```text
main
 │
 └── hotfix/1.2.1 ── fix ── CI ── App Store Release
                                      │
                                      ▼
                                     main ── v1.2.1
                                      │
                                      └────────► release   （sync）
```

### Large

```text
feature/*
     │
     ▼
  develop
     │
     ▼
release/1.4.0
     ├─ CI
     ├─ Release Candidate 検証（TestFlight）
     │
     ▼
App Store Release
     │
     ▼
    main ── v1.4.0
     │
     └────────► develop   （sync、その後 release/1.4.0 は削除可）
```

Large の hotfix:

```text
main
 │
 └── hotfix/1.4.1 ── fix ── CI ── App Store Release
                                      │
                                      ▼
                                     main ── v1.4.1
                                      │
                                      ├────────► develop
                                      └────────► release/*（進行中の Candidate があれば）
```

---

## 共通原則

- `main` は Production Release 系統。通常の feature 開発には使わない。
- **実際に公開されたバージョンは Git Tag `vX.Y.Z` で確定する。** Tag = App Store 公開版の正本。
- Production Tag の上書きは禁止。`finish_release` / `finish_hotfix` は既存 tag を絶対に動かさない。
- direct push 禁止: Small = `main` / `release`、Large = `main` / `develop` / `release/*`。
- Release / Hotfix に関わる branch 作成・merge・tag 生成は MCP から実行する。
- conflict は自動解決しない。**何も merge せずに停止して報告する。**
- `force push` / `reset --hard` / `tag overwrite` / `history rewrite` は自動実行しない。
- branch 削除は「production に完全に含まれている」ことを確認したうえで、明示指定がある場合のみ。

---

## Repository Config

Strategy は毎回推測せず、リポジトリに commit される設定ファイルで固定する。

`.app-dev-mcp.json`:

```json
{
  "schemaVersion": 1,
  "lifecycle": "released",
  "strategy": "small",
  "platform": "ios",
  "project": { "path": "MyApp.xcodeproj", "scheme": "MyApp" },
  "branches": {
    "production": "main",
    "development": "release",
    "hotfixPrefix": "hotfix/",
    "releasePrefix": "release/",
    "featurePrefix": "feature/"
  },
  "release": { "mergeStrategy": "merge", "requireCleanWorktree": true, "requireCi": true },
  "hotfix": { "source": "main" },
  "github": { "requirePullRequestToProduction": true, "blockForcePushProduction": true }
}
```

- Strategy を暗黙的に変更してはならない。変更は `migrate_strategy` のみ。
- 旧 `.appdev.yml`（small-app-dev-mcp v0.1）も読み込める。`setup_repository` 実行時に
  `.app-dev-mcp.json` へ移行する（旧ファイルは削除せず残す）。
- `.app-dev-mcp.state.json` は Release Candidate の作業記録（ローカルキャッシュ）で、
  `setup_repository` が `.gitignore` に追加する。**公開の正本は annotated tag。**

---

## Tool Reference

| Tool | 役割 |
| --- | --- |
| `get_app_status` | **最初に呼ぶ。** managed/unmanaged・strategy・branch・production tag・active release/hotfix・divergence・CI・blocking issues・next action |
| `setup_repository` | 公開済みアプリを MCP 管理下へ登録。config 生成 / branch 検証 / workflow 生成 / branch protection。冪等 |
| `prepare_release` | Release Candidate の準備と検証。Small = `release`、Large = `develop` → `release/X.Y.Z` |
| `create_release_pr` | Release Candidate → `main` の PR 作成（**merge はしない**） |
| `finish_release` | **App Store 公開確定後**に Git を確定。production merge / tag / push / sync / 一時 branch cleanup |
| `start_hotfix` | `main` から hotfix branch 作成（development branch からは作らない） |
| `finish_hotfix` | hotfix の PR 作成 →（merge 後）tag 作成と sync（Small: `release` / Large: `develop` + active `release/*`） |
| `sync_release` | production を development ライン（+ 進行中 Candidate）へ merge |
| `migrate_strategy` | Strategy 移行（`small → large` が主対象）。既定で dry-run |
| `doctor` | Policy 違反の診断のみ。**勝手に修正しない** |

すべての Tool は `dry_run` を持つ（`migrate_strategy` は既定 `true`）。

### 典型的な Release フロー

```text
get_app_status
    ↓
prepare_release(version: "1.4.0")      # 検証 + Large は release/1.4.0 作成
    ↓
create_release_pr(version: "1.4.0")    # PR 作成（merge は人間が行う）
    ↓
（App Store Connect MCP で submit / review / 公開）
    ↓
finish_release(version: "1.4.0")       # main merge 確認 → v1.4.0 tag → sync → cleanup
```

### 典型的な Hotfix フロー

```text
get_app_status
    ↓
start_hotfix(name: "startup crash", version: "1.4.1")
    ↓
（修正を commit）
    ↓
finish_hotfix(name: "startup crash", version: "1.4.1")   # PR 作成
    ↓
（PR merge + App Store 公開）
    ↓
finish_hotfix(name: "startup crash", version: "1.4.1")   # tag + sync
```

`finish_hotfix` は 2 段階。まだ `main` に入っていなければ PR を用意して停止し、
`main` に入っていれば tag を作って sync まで行う。

### Strategy Migration

```text
migrate_strategy(to: "large")                      # dry-run（既定）
migrate_strategy(to: "large", dry_run: false)      # 適用
```

`small → large` では `release` の内容を `develop` へ引き継ぎ、workflow を Large 用へ入れ替える。
**branch は自動削除しない。** ただし `refs/heads/release` が残っていると Git は
`refs/heads/release/X.Y.Z` を作れないため、`develop` に取り込まれたことを確認してから
`git branch -d release`（および origin 側の削除）を各自で実行すること。
`large → small` は履歴・active release を失う危険があるため `confirm: true` が必須。

---

## GitHub Actions

Workflow テンプレートは common / strategy に分離されている（`src/workflows/`）。

Small:

```text
ci.yml        PR → main / release、push → release
release.yml   main への release / hotfix PR が merge されたとき
```

Large:

```text
ci.yml                     PR → main / develop / release/*、push → develop
internal-testflight.yml    push → develop（内部ビルド）
release-candidate.yml      push → release/*（Candidate ビルド）
production.yml             main への release/* / hotfix/* PR が merge されたとき
```

生成ファイルの 1 行目には `# managed-by: released-app-dev-mcp` マーカーが入る。
マーカーの無い自作ファイルは上書きしない（旧 `small-app-dev-mcp` マーカーも認識して更新する）。

## Traceability

Release Candidate と公開版は次の情報で追跡できる。

```text
Version / Build / Commit SHA / Strategy / Source Branch / Release Candidate timestamp
```

- 作業中の記録: `.app-dev-mcp.state.json`（gitignore 済み）
- 公開の正本: annotated tag `vX.Y.Z` のメッセージに Build / Strategy / Source / Commit を記録
- GitHub Actions 側は各 workflow の job summary に commit / branch / run URL を出力

---

## App Store Connect との境界

この MCP は **Git / GitHub / Branch / CI / Release Candidate / Release State / Tag** のみを担当する。

```text
Released App Development MCP
            │  Release Candidate を準備
            ▼
      App Store Connect MCP
            │
            ▼
   TestFlight / Review / Release
```

App Store 提出・審査・公開操作、および Xcode ビルドの内製化はスコープ外。

---

## Installation

Node / pnpm のバージョンは [mise](https://mise.jdx.dev/)（`.mise.toml`）で固定している。

```bash
mise install
pnpm install
pnpm run build
pnpm run test     # Node 22+ / Git 2.38+ が必要
```

MCP サーバーは **対象アプリのリポジトリを working directory として**、または
`APP_DEV_PROJECT_DIR` でパスを指定して起動する。1 プロセス = 1 アプリリポジトリ。

```bash
export APP_DEV_PROJECT_DIR=/path/to/your/ios-app
export GITHUB_TOKEN=ghp_xxx   # repo スコープ。未設定でもローカル Git 操作は動作する
```

MCP client 設定例:

```json
{
  "mcpServers": {
    "released-app-dev": {
      "command": "node",
      "args": ["/path/to/released-app-dev-mcp/packages/released-app-dev-mcp/dist/index.js"],
      "env": {
        "APP_DEV_PROJECT_DIR": "/path/to/your/ios-app",
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

`GITHUB_TOKEN` が無い場合、CI 状態確認 / PR 作成 / branch protection のみ利用不可になり、
それ以外のローカル Git 操作はそのまま動作する。

## 構成

```text
packages/
├── git-core/                 # Git / GitHub / PR / Actions / project-detection / validation
└── released-app-dev-mcp/
    ├── src/core/             # config / context / checks / merge / release / state / status / files
    ├── src/strategies/       # types / base / small / large / registry
    ├── src/workflows/        # common templates + small / large
    ├── src/tools/            # MCP Tool 実装
    └── tests/                # small / large / safety / migrate
```

Strategy 側に `git checkout` / `git merge` / GitHub API などの low-level 実装を重複させない。
Strategy が決めるのは「どの branch か」だけで、実際の Git 操作は Core が行う。
第 3 の Strategy を追加するときは `src/strategies/index.ts` の registry に 1 行足す。

---

## Codex / AI Agent 向け恒久ルール

公開済みアプリのリポジトリで作業する場合:

1. **最初に必ず `get_app_status` を呼ぶ。**
2. `lifecycle = released` なのに MCP 未設定（`.app-dev-mcp.json` が無い）なら
   `setup_repository` を最優先する。
3. 次の操作は必ず MCP 経由で行う:
   release 開始 / release PR / release 完了 / hotfix 開始 / hotfix 完了 /
   production merge / tag 作成 / strategy migration
4. 次を独自判断で実行してはならない:

```text
released app での main への direct push
手動 production tag
手動 release branch 生成
手動 hotfix branch 生成
MCP を無視した release merge
MCP を無視した branch strategy 変更
```

5. MCP が使えない場合は fallback せず停止して報告する（上記「MCP が使えないとき」参照）。

未公開アプリ（`lifecycle = development`）にはこの厳格な Policy を強制しない。
初回 App Store Release が完了した時点で `setup_repository` により本 MCP 管理へ移行する。

---

## Troubleshooting

| 症状 | 対処 |
| --- | --- |
| `unmanaged released app` と言われる | `setup_repository(strategy: "small" \| "large")` |
| `setup_repository` が strategy を要求する | Strategy は推測しない仕様。提案は出るが決めるのは人間 |
| workflow が生成されない | Xcode project / scheme を検出できていない。`.app-dev-mcp.json` の `project.path` / `project.scheme` を指定 |
| `production tag "vX.Y.Z" is not taken` で止まる | 公開済み tag は上書きしない。バージョンを上げる |
| Large で `release/X.Y.Z` を作れない | `release` branch が残っている。`develop` に取り込んだ後に削除する |
| CONFLICT で停止した | 自動解決しない仕様。`git checkout <target> && git merge <source>` で手動解決 |
| CI が `no checks found` | commit を push していない、または `GITHUB_TOKEN` 未設定 |
| 何が壊れているか分からない | `doctor` |
