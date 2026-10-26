# Metriever AWS移行プロジェクト 進捗ドキュメント

最終更新: 2026-10-26

## 1. プロジェクトの目的

`Metriever/PDF/` にあるLangChain/LangGraphベースのRAG技術解説資料（7本）を題材に、同等以上のRAGアプリケーションを **AWS Bedrockのマネージド機能** で構築し直す。単なる実装だけでなく、CDK(TypeScript)によるIaC化と、CI/CDデプロイパイプライン・データ取り込みパイプラインを備えた「本番運用を見据えた開発プロセス」を確立することが目的。

## 2. ここまでの技術的な意思決定

| 決定事項 | 理由 |
|---|---|
| LLM/RAG基盤をAzure OpenAIからAWS Bedrockへ全面移行 | 既存資料のRetrieval Grader・Query Decomposition・複数DB横断検索は、Bedrockの`AgenticRetrieveStream`で代替可能と判明したため |
| Managed Knowledge Base (MKB) を採用 | チャンク分割・埋め込み・ベクトルストアをAWSが管理し、インフラ構築が不要なため |
| IaC: AWS CDK (TypeScript) | チームのAWS標準に合わせ、型安全性と再利用性を優先 |
| CDKプロジェクトは`Metriever/infra/`に配置、独立したGitリポジトリ化 | 既存のuv管理Pythonプロジェクト（学習用資料）と、本番インフラコードを分離するため |
| GitHubリポジトリは`uchidaatsuyastudy-hash/RAG_AWS_MIG`（Public） | ユーザー指定。Public化に伴い、AWSアカウントIDは環境変数(`CDK_DEFAULT_ACCOUNT`)経由に変更し、ソースコードに直接書き込まない設計に修正済み |
| ブランチ戦略: トランクベース（`main`1本） | CDK Pipelinesが「同じパイプライン実行内でDev→承認→Prodと昇格する」構成のため、環境ごとのブランチ分岐は不要と判断 |
| 社内PDF資料は実際のKnowledge Baseに入れない | ユーザー指示により、検証用データはWebから取得した公開ドキュメント（AWS Well-Architected Framework、Attention Is All You Need論文）に差し替え済み |

## 3. 全体アーキテクチャ

```
GitHub(main) --push--> CodeConnections --> CodePipeline(Metriever-Pipeline)
                                              │
                                   Source → Build(Synth) → UpdatePipeline(SelfMutate)
                                              │
                                              ▼
                                       Dev Stage（自動デプロイ）
                                   Metriever-Foundation（KMS鍵、Budgets）
                                   Metriever-Data（S3生データバケット＋アクセスログ）
                                   Metriever-KnowledgeBase（Bedrock Managed KB）
                                   SmokeTest
                                              │
                                     手動承認(PromoteToProd)
                                              │
                                              ▼
                                       Prod Stage（承認後デプロイ）
                                   ※同じ3スタックをProd環境に展開
```

## 4. これまでに完了したこと

### Phase 0: プロジェクト基盤（完了）
- `Metriever/infra/`にCDK TypeScriptプロジェクトを新規作成
- gitが未インストールだったためwingetで導入し、リポジトリ初期化
- アカウント`841535407111`・リージョン`ap-southeast-2`へCDKブートストラップ
- `FoundationStack`実装: KMS CMK（ログ用・データ用）、cdk-nagセキュリティベースライン、AWS Budgetsコストアラート
- 実装中、計画で想定していた`cdk-nag` v3系がAPIを刷新していたことが判明し、安定版v2.38.2に固定して対応

### Phase 1: CI/CDパイプライン（完了）
- CodeConnectionsでGitHub連携を作成し、コンソールでOAuth認証を完了
- `aws-cdk-lib/pipelines`による自己更新型CodePipelineを構築（Source→Build→SelfMutate→Dev→承認→Prod）
- **トラブルと対処**: 初回デプロイ時、ローカルで作成した新しいコード（PipelineStack関連ファイル）をGitHubにpushし忘れたまま`cdk deploy`したため、SelfMutateステージが「GitHub上の古いコードには存在しないスタック名」を探しに行って失敗。pushし忘れに気づき、コミット・プッシュ後に再実行して解消
- 現在、Source→Build→SelfMutate→Dev→SmokeTestまで安定して成功する状態を確認済み

### Phase 2: Managed Knowledge Base（進行中・一時停止中）
- `DataStack`実装: S3生データバケット（SSE-KMS暗号化、バージョニング、サーバーアクセスログ有効）
- `KnowledgeBaseStack`実装: Bedrock Managed Knowledge Base（`type: MANAGED`）＋S3マネージドコネクタのDataSource。CDKのL1コンストラクトが両方ともMANAGEDタイプに対応していることを事前に確認済み
- cdk-nagの指摘（S3アクセスログ未設定、IAM読み取り系ワイルドカード）に対し、正当な理由を添えてサプレッション、またはアクセスログバケット追加で対応
- Dev環境へのデプロイに成功し、Knowledge Base ID (`0EFAJMEAWJ`)・DataSource ID (`RFS74XRKHK`) を取得
- 当初は`Metriever/PDF/`の7資料をテストデータとして投入したが、ユーザー指示により削除し、Web公開ドキュメント（AWS Well-Architected Frameworkホワイトペーパー、論文"Attention Is All You Need"）に差し替え
- **現在のブロッカー**: 取り込みジョブが `IN_PROGRESS` のまま約19分間進捗ゼロで停止したように見えたため `stop-ingestion-job` を実行したが、`STOPPING` 状態からさらに約7分経過しても変化がない。原因はMKBという比較的新しいマネージド機能自体の不安定さの可能性が高く、CloudTrail/CloudWatch Logsをまだ有効化していないため詳細なログで裏付けが取れない状態

## 5. 今、判断待ちになっていること

取り込みジョブが完全にスタックしている状況で、以下の対応案を提示中。

| 選択肢 | 内容 |
|---|---|
| a. さらに待つ | コストはほぼ発生しないが、再現性のない不具合に時間を使うリスク |
| b. Data Source/Knowledge Baseを削除して作り直す（推奨） | CDK管理下のリソースなので、CLIで一度削除→再作成しても定義は失われない |
| c. AWSサポートに問い合わせる | 根本原因を特定したい場合。FREEプランでは対応に時間がかかる可能性 |

## 6. このあとやろうとしていること

1. **直近**: 上記ブロッカーの解消（b案で作り直し予定、ユーザー承認待ち）
2. 取り込み完了後、`Retrieve` APIで実際に検索結果が返ることを確認（例: 「What are the pillars of the AWS Well-Architected Framework?」）
3. **Phase 3**: データ取り込みパイプラインの自動化（S3イベント→SQSデバウンス→Step Functionsでの`start-ingestion-job`自動実行、失敗時のSNSアラート）
4. **Phase 4**: `AgenticRetrieveStream`ラッパーLambdaの実装（Query Decomposition相当の反復検索、Managed Reranking、複数Knowledge Base横断検索）
5. **Phase 5**: Guardrails（コンテンツフィルタ）＋AgentCore Harness（RAG/一般知識/Web検索のエージェント的ルーティング）
6. **Phase 6**: 評価・観測性基盤（CloudTrailデータイベント有効化、AgentCore Evaluations、CloudWatchダッシュボード）— これまでの技術評価で指摘した「最大の欠落点」への対応
7. **Phase 7**: IAM最小権限の最終監査、コストレビュー、運用Runbook作成

その後、Dev環境で一通り動作確認ができた段階で、`PromoteToProd`の手動承認を行いProd環境へ昇格する。

## 7. 参考資料

- 実装計画の全文: `C:\Users\LF83993\.claude\plans\cozy-crunching-hammock.md`
- PDF資料群の技術評価: 本セッションの会話履歴を参照（別途ドキュメント化を予定）
