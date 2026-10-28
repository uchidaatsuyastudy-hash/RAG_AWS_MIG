# Metriever RAGシステム 仕様書

最終更新: 2026-10-28
対象: `infra/`配下のCDK(TypeScript)実装（コミット `3be2002` 時点のコードから作成した逆生成仕様書）

本書は実装コード（`infra/lib`, `infra/lambda`, `infra/bin`）を正としてリバースエンジニアリングした技術仕様書である。学習用の経緯説明は`progress.md`、運用手順は`runbook.md`を参照。

---

## 1. 概要

AWS Bedrock Managed Knowledge Base を中核としたRAG（Retrieval Augmented Generation）システム。ドキュメントのS3アップロードを起点に自動で検索インデックスへ取り込み、Lambda経由でのAPI呼び出しにより「検索結果の取得」または「RAG/一般知識を判断した上での回答生成」を提供する。インフラは AWS CDK (TypeScript) で定義し、GitHub連携のCI/CDパイプラインでDev/Prod 2環境に同一構成をデプロイする。

### 1.1 非対象（スコープ外）

- フロントエンドUI、API Gateway等の公開APIエンドポイント（現状は`aws lambda invoke`による直接呼び出しのみ）
- 認証・認可機構（エンドユーザー単位のアクセス制御）
- AgentCore Harness／Evaluationsの利用（§11参照）

---

## 2. 前提条件・環境制約

| 項目 | 値 |
|---|---|
| AWSアカウント | `CDK_DEFAULT_ACCOUNT`環境変数から動的解決（リポジトリにハードコードしない） |
| リージョン | `ap-southeast-2`（シドニー）に固定。クロスリージョンリソース作成は禁止 |
| アカウントプラン | FREE（`aws freetier get-account-plan-state`で確認。AWS Marketplace利用は "Bedrock and Free only" に制限） |
| IaC | AWS CDK `aws-cdk-lib ^2.273.0` / CDK CLI `2.1146.1` |
| cdk-nag | `^2.38.2`固定（v3はAPI breaking change のため使用不可） |
| Node.jsランタイム | `NODEJS_22_X`（全Lambda共通） |
| 言語 | TypeScript（`typescript ~7.0.2`） |

---

## 3. システムアーキテクチャ

```
GitHub(main) --push--> CodeConnections --> CodePipeline (Metriever-Pipeline)
                                              Source → Build(Synth) → UpdatePipeline(SelfMutate) → Assets
                                              → Dev Stage(8スタック) → SmokeTest(ShellStep, 未実装の簡易チェック)
                                              → ManualApprovalStep(PromoteToProd) → Prod Stage(8スタック)

[環境ごと: Dev または Prod]

[S3 RawDocsBucket] --ObjectCreated/Removed--> [SQS ChangeQueue(+DLQ)]
                                                    │
                                     EventBridge Pipe (batchSize=100, window=300s)
                                                    ▼
                                     [Step Functions: IngestionOrchestration]
                                       StartIngestionJob → Wait(30s) → GetIngestionJob(poll)
                                       → Choice(COMPLETE/FAILED/STOPPED/継続)
                                                    │                     │
                                                    ▼                     ▼
                                     [Bedrock Managed Knowledge Base]  [SNS失敗通知 + CloudWatchアラーム]
                                     (S3 Managed Connector, Embedding: MANAGED)
                                                    │
                     EventBridge Scheduler(毎日 UTC18:00=JST03:00) --無条件再実行--> 同Step Functions

[Lambda: RetrievalService] --Retrieve/AgenticRetrieveStream--> [Knowledge Base]
        ▲
        │ grantInvoke
[Lambda: Agent] --Converse(tool_use)--> [Bedrock Runtime: au.anthropic.claude-sonnet-4-6]
        │                                   │
        │ ApplyGuardrail(guardrailConfig)   │
        └────────────> [Bedrock Guardrail] <┘

横断: CloudTrail(KB/Guardrailデータイベント) + CloudWatch Dashboard/Alarms + KMS(CMK)暗号化全般
```

---

## 4. スタック構成

8つのアプリケーションスタックを`ApplicationStage`（`lib/stages/application-stage.ts`）が束ね、`PipelineStack`がDev/Prodそれぞれに1インスタンスずつデプロイする。依存順序（CDKのプロパティ渡しによる暗黙の依存関係）:

```
Foundation → Data → KnowledgeBase → IngestionPipeline
                                  → RetrievalService → Guardrail → Agent → Observability
```

スタックIDは`<Stage名>-Metriever-<スタック名>`（例: `Dev-Metriever-Foundation`）。

### 4.1 FoundationStack (`lib/stacks/foundation-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `envName: string`（必須）, `budgetAlertEmail?`, `monthlyBudgetLimitUsd?` |
| 出力 | `logsKey: kms.Key`, `dataKey: kms.Key` |
| リソース | KMSキー×2（`metriever/<envName>/logs`, `metriever/<envName>/data`、両方`enableKeyRotation: true`, `RemovalPolicy.RETAIN`） |
| KMSキーポリシー | `logsKey`に対し (a) `logs.<region>.amazonaws.com`への`Encrypt*/Decrypt*/ReEncrypt*/GenerateDataKey*/Describe*`（`kms:EncryptionContext:aws:logs:arn`条件付き）、(b) `cloudtrail.amazonaws.com`への`GenerateDataKey*/Decrypt*/DescribeKey`（`aws:SourceAccount`+`kms:EncryptionContext:aws:cloudtrail:arn`条件付き） |
| Budgets | `budgetAlertEmail`指定時のみ: SNSトピック(dataKey暗号化)+メール購読、`CfnBudget`（月次、デフォルト上限$100、50/80/100%で通知） |

### 4.2 DataStack (`lib/stacks/data-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `dataKey: kms.IKey` |
| 出力 | `rawDocsBucket: s3.Bucket`, `changeQueue: sqs.Queue` |
| TerminationProtection | 有効 |
| `AccessLogsBucket` | SSE-S3、`BLOCK_ALL`、90日で自動削除、`RETAIN` |
| `RawDocsBucket` | SSE-KMS(`dataKey`)、バージョニング有効、`enforceSSL`、`serverAccessLogsBucket`=AccessLogsBucket、`RETAIN` |
| `RawDocsChangeDlq` / `RawDocsChangeQueue` | 両方`SQS_MANAGED`暗号化（CMKではない。理由: Foundation↔Data循環依存回避）。DLQ保持14日、本体保持4日、`maxReceiveCount: 3` |
| S3イベント通知 | `OBJECT_CREATED`/`OBJECT_REMOVED` → `RawDocsChangeQueue` |

### 4.3 KnowledgeBaseStack (`lib/stacks/knowledge-base-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `rawDocsBucket: s3.IBucket`, `dataKey: kms.IKey`, `envName: string` |
| 出力 | `knowledgeBaseId: string`, `dataSourceId: string` |
| TerminationProtection | 有効 |
| IAMロール | `AmazonBedrockExecutionRoleForKB-metriever-<envName>`。信頼ポリシー: `bedrock.amazonaws.com`（`aws:SourceAccount`+`aws:SourceArn`条件のconfused deputy対策）。権限: `rawDocsBucket.grantRead()` + `dataKey.grantDecrypt()` |
| `CfnKnowledgeBase` | `name: metriever-kb-<envName>`、`knowledgeBaseConfiguration.type: MANAGED`、`managedKnowledgeBaseConfiguration.embeddingModelType: MANAGED` |
| `CfnDataSource` | `name: metriever-raw-docs-<envName>`、`dataSourceConfiguration.type: MANAGED_KNOWLEDGE_BASE_CONNECTOR`、`connectorParameters.type: S3`、`bucketName`/`bucketOwnerAccountId`指定 |
| メディア抽出設定 | 明示的なオーバーライドなし＝AWSデフォルト（画像抽出ENABLED）。意図的に無効化していない（§11参照） |

### 4.4 IngestionPipelineStack (`lib/stacks/ingestion-pipeline-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `changeQueue: sqs.IQueue`, `dataKey: kms.IKey`, `knowledgeBaseId: string`, `dataSourceId: string`, `failureAlertEmail?: string` |
| 出力 | `stateMachine: sfn.StateMachine` |
| 独自の差分管理 | なし。`StartIngestionJob`自体が新規/更新/削除件数を内部判定するため、DynamoDBでの差分追跡テーブルは実装していない（当初計画からの変更） |
| Step Functions定義 | `StartIngestionJob`(ASL `aws-sdk:bedrockagent:startIngestionJob`, `BedrockAgent.ConflictException`は成功扱いでキャッチ) → `Wait30Seconds` → `GetIngestionJob`(ポーリング) → `Choice`(`COMPLETE`→成功 / `FAILED`,`STOPPED`→`NotifyFailure`(SNS)後に失敗 / それ以外→Wait へループ)。タイムアウト30分 |
| IAM | `bedrock:StartIngestionJob`/`GetIngestionJob`をKB ARNにスコープ |
| EventBridge Pipe | `ChangeDebouncePipe`。ソース: `changeQueue`、`sqsQueueParameters: {batchSize:100, maximumBatchingWindowInSeconds:300}`、ターゲット: StateMachine（`FIRE_AND_FORGET`） |
| 安全網スケジュール | `DailyReconciliation`（cron `hour:18, minute:0` UTC = JST 03:00）で無条件に同StateMachineを起動 |
| 失敗通知 | `IngestionFailureTopic`(SNS, dataKey暗号化) + `failureAlertEmail`があればメール購読。`IngestionFailedAlarm`(`metricFailed()`閾値1) |

### 4.5 RetrievalServiceStack (`lib/stacks/retrieval-service-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `knowledgeBaseIds: string[]`, `logsKey: kms.IKey` |
| 出力 | `retrievalFunction: lambda.IFunction` |
| Lambda | `NodejsFunction`、エントリ`lambda/retrieval-service/index.ts`、timeout 60秒、memory 512MB、専用ロググループ(KMS暗号化) |
| 環境変数 | `KNOWLEDGE_BASE_IDS`(カンマ区切り), `MAX_AGENT_ITERATION=5` |
| IAM | ① `bedrock:Retrieve`をKB ARN群にスコープ。② `bedrock:AgenticRetrieveStream`は`Resource: "*"`（リソースタイプ非対応のため、実機検証で確認済み）。③ `bedrock:InvokeModel*`を`foundation-model/*`（当該リージョン内）にスコープ（マネージド・プランナー/埋め込み/リランキングモデル用） |

### 4.6 GuardrailStack (`lib/stacks/guardrail-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `dataKey: kms.IKey`, `envName: string` |
| 出力 | `guardrailId: string`, `guardrailVersion: string` |
| `CfnGuardrail` | `name: metriever-guardrail-<envName>`、`kmsKeyArn: dataKey` |
| コンテンツフィルタ | HATE/INSULTS/SEXUAL/VIOLENCE/MISCONDUCT（`inputStrength: HIGH`, `outputStrength: HIGH`）＋ PROMPT_ATTACK（`inputStrength: HIGH`, `outputStrength: NONE`） |
| PIIマスキング | EMAIL/PHONE/NAME/ADDRESS/US_SOCIAL_SECURITY_NUMBER/CREDIT_DEBIT_CARD_NUMBER を`ANONYMIZE` |
| バージョニング | `CfnGuardrailVersion`で明示的にバージョン発行 |

### 4.7 AgentStack (`lib/stacks/agent-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `retrievalFunction: lambda.IFunction`, `guardrailId`, `guardrailVersion`, `logsKey: kms.IKey`, `guardrailKey: kms.IKey`, `modelId?: string` |
| 出力 | `agentFunction: lambda.IFunction` |
| デフォルトモデル | `au.anthropic.claude-sonnet-4-6`（地理的推論プロファイル。オンデマンド直接呼び出し非対応のため必須。`global.`ではなく`au.`を選択しAUS域内＝ap-southeast-2/ap-southeast-4に限定） |
| Lambda | timeout 90秒、memory 512MB |
| 環境変数 | `MODEL_ID`, `RETRIEVAL_FUNCTION_NAME`, `GUARDRAIL_ID`, `GUARDRAIL_VERSION`, `MAX_TOKENS=1024`, `MAX_TOOL_ITERATIONS=4` |
| IAM | ① `retrievalFunction.grantInvoke()`。② `bedrock:InvokeModel*`を推論プロファイルARN＋両リージョン(ap-southeast-2/ap-southeast-4)のfoundation-model ARNに付与。③ `bedrock:ApplyGuardrail`をguardrail ARNにスコープ。④ `guardrailKey.grantDecrypt()`。⑤ `aws-marketplace:ViewSubscriptions`/`Subscribe`を`Resource:"*"`で付与（Anthropicモデルの初回自動サブスクリプション用） |

### 4.8 ObservabilityStack (`lib/stacks/observability-stack.ts`)

| 項目 | 内容 |
|---|---|
| 入力Props | `logsKey`, `knowledgeBaseId`, `guardrailId`, `retrievalFunction`, `agentFunction`, `ingestionStateMachine`, `envName` |
| CloudTrail | `DataEventTrail`（`trailName: metriever-data-events-<envName>`、`logsKey`暗号化、CloudWatch Logs連携）。Advanced Event Selectorsで`AWS::Bedrock::KnowledgeBase`と`AWS::Bedrock::Guardrail`のデータイベントを明示的に有効化（デフォルトでは記録されないため） |
| CloudWatch Dashboard | `Metriever-<envName>`。Agent/Retrievalの呼び出し数・エラー数・処理時間、取り込みStateMachineの成功/失敗数 |
| アラーム | `AgentErrorAlarm`, `RetrievalErrorAlarm`（いずれも`metricErrors()`閾値1） |
| 未実装 | AgentCore Evaluations（LLM-as-judge自動採点）は非導入。理由は§11参照 |

### 4.9 PipelineStack / ApplicationStage (`lib/pipeline-stack.ts`, `lib/stages/application-stage.ts`)

| 項目 | 内容 |
|---|---|
| パイプライン名 | `Metriever-Pipeline`（`aws-cdk-lib/pipelines.CodePipeline`、自己更新型） |
| ソース | CodeConnections（GitHub `uchidaatsuyastudy-hash/RAG_AWS_MIG`、ブランチ`main`） |
| Synthステップ | `npm ci && npm run build && npm test && npx cdk synth` |
| Devステージ | `budgetAlertEmail`（コンテキスト経由）, `monthlyBudgetLimitUsd: 20`。デプロイ後に`SmokeTest`(ShellStep、現状はプレースホルダのecho) |
| Prodステージ | `monthlyBudgetLimitUsd: 80`。デプロイ前に`ManualApprovalStep('PromoteToProd')` |
| cdk-nag | `ApplicationStage`コンストラクタ内で`Aspects.of(this).add(new AwsSolutionsChecks())`（CDK Pipelines配下のStageにはApp直下のAspectsが伝播しないための個別対応） |

---

## 5. Lambda関数インターフェース仕様

### 5.1 RetrievalService (`lambda/retrieval-service/index.ts`)

**リクエスト**
```typescript
{
  question: string;              // 必須。空文字/空白のみは400相当のErrorをthrow
  knowledgeBaseIds?: string[];   // 省略時は環境変数のデフォルトKB群を使用
}
```

**レスポンス**
```typescript
{
  answer: string;      // 生成された回答（generateResponse:trueのため）
  results: unknown[];  // 検索結果チャンク配列
  trace: unknown[];    // プランナー/イテレーションのトレース情報
}
```

**内部処理**: `AgenticRetrieveStreamCommand`を呼び出し、`agenticRetrieveConfiguration: {foundationModelType:'MANAGED', rerankingModelType:'MANAGED', maxAgentIteration:5}`。ストリームを`for await`で走査し、`responseEvent.text`/`result.results`/`result.generatedResponse.answer`/`traceEvent`を蓄積。ストリーム内の例外イベント（`internalServerException`等9種）は検出時に即`throw`。

### 5.2 Agent (`lambda/agent/index.ts`)

**リクエスト**
```typescript
{ question: string; }
```

**レスポンス**
```typescript
{
  answer: string;
  toolCalls: number;  // search_knowledge_base ツールの呼び出し回数
}
```

**内部処理**: Bedrock Converse APIでツール呼び出し（`search_knowledge_base`、1ツールのみ）によるエージェントループを実装。最大`MAX_TOOL_ITERATIONS`（既定4）回イテレーション。`stopReason === 'tool_use'`の間、ツール呼び出し内容を抽出し`RetrievalService`をLambda-to-Lambda呼び出し（`InvokeCommand`）、結果を`toolResult`としてConverseの会話に追加して継続。`guardrailConfig`を全呼び出しに付与。イテレーション上限到達時は`Error`をthrow。

---

## 6. IAM権限一覧（抜粋・スタック横断）

| 主体 | 権限 | リソーススコープ | 備考 |
|---|---|---|---|
| KnowledgeBaseRole | `s3:GetObject*`等(grantRead), `kms:Decrypt*`(grantDecrypt) | RawDocsBucket ARN, dataKey ARN | confused deputy対策の信頼ポリシー付き |
| IngestionOrchestration (StateMachine) | `bedrock:StartIngestionJob`/`GetIngestionJob` | 対象KB ARN | — |
| RetrievalService Lambda | `bedrock:Retrieve` | KB ARN群 | スコープ可能 |
| RetrievalService Lambda | `bedrock:AgenticRetrieveStream` | `"*"` | **リソースタイプ非対応**（実機検証済み） |
| RetrievalService Lambda | `bedrock:InvokeModel*` | `foundation-model/*`（当該リージョン） | マネージドモデル選定がAWS内部のため個別ARN指定不可 |
| Agent Lambda | `bedrock:InvokeModel*` | 推論プロファイルARN + foundation-model ARN×2リージョン | `au.`プロファイルの実体リージョンに対応 |
| Agent Lambda | `bedrock:ApplyGuardrail` | Guardrail ARN | — |
| Agent Lambda | `kms:Decrypt*`(grantDecrypt) | guardrailKey(=dataKey) ARN | Guardrail設定の復号に必要 |
| Agent Lambda | `aws-marketplace:ViewSubscriptions`/`Subscribe` | `"*"` | **リソースタイプ非対応**。Anthropicモデルの初回自動サブスクリプション用 |
| Agent Lambda | Lambda `InvokeFunction` (grantInvoke) | RetrievalService Function ARN(`:*`) | ツール呼び出し用 |

---

## 7. データフロー

### 7.1 文書取り込みフロー
1. S3 `RawDocsBucket`へオブジェクトが作成/削除される
2. S3イベント通知がSQS `RawDocsChangeQueue`へ送信
3. EventBridge Pipeが最大300秒・最大100件までバッチ化し、Step Functionsを1回起動（デバウンス）
4. `StartIngestionJob`実行（既に実行中の場合は`ConflictException`を正常扱い）
5. 30秒間隔で`GetIngestionJob`をポーリング
6. `COMPLETE`で成功終了、`FAILED`/`STOPPED`でSNS通知後に失敗終了
7. 毎日JST 03:00に無条件で同フローが再実行される（安全網）

### 7.2 検索フロー（RetrievalService単体呼び出し）
1. 呼び出し元が`question`を渡してLambdaを`Invoke`
2. `AgenticRetrieveStream`がクエリ分解・複数KB横断検索・リランキング・（任意で）回答生成をAWS側で実施
3. ストリームを集約し`{answer, results, trace}`を返却

### 7.3 エージェント応答フロー
1. 呼び出し元が`question`を渡してAgent Lambdaを`Invoke`
2. Converse APIが`search_knowledge_base`ツールを使うべきか自律判断
3. ツール使用時: Agent LambdaがRetrievalService Lambdaを内部`Invoke`→結果をConverseに還元→再度Converseを呼び出し
4. 最終応答（`stopReason !== 'tool_use'`、または`MAX_TOOL_ITERATIONS`到達）でテキストを抽出し`{answer, toolCalls}`を返却
5. 全Converse呼び出しにGuardrailが適用される

---

## 8. CI/CDパイプライン仕様

詳細は`progress.md`§8参照。概要:

| ステージ | 内容 |
|---|---|
| Source | CodeConnections経由でGitHub `main`ブランチの変更を検知 |
| Build | `npm ci`, `npm run build`, `npm test`, `npx cdk synth`（失敗時はここで停止） |
| UpdatePipeline | パイプライン自身の定義変更があれば自己更新 |
| Assets | Lambdaコード等の成果物をS3へアップロード |
| Dev | 8スタックを依存順にデプロイ→SmokeTest(ShellStep、現状プレースホルダ) |
| Prod | 手動承認(`PromoteToProd`)後、8スタックをデプロイ |

環境名(`envName: 'dev'|'prod'`)は`PipelineStack`→`ApplicationStage`→各スタックへpropsとして伝搬し、アカウント/リージョン単位で一意制約のあるリソース名（KMSエイリアス、IAMロール名、Bedrock Guardrail/KB名、CloudTrail証跡名、CloudWatchダッシュボード名）の衝突回避に使用する。

---

## 9. セキュリティ仕様

- **暗号化**: S3（SSE-KMS）、SNS（dataKey）、CloudWatch Logs（logsKey、全Lambda/StateMachine共通）、CloudTrail（logsKey）、Guardrail設定（dataKey）。SQS変更通知キューのみSQS_MANAGED（循環依存回避のための例外、ドキュメント内に理由明記）
- **confused deputy対策**: KnowledgeBaseRoleの信頼ポリシーに`aws:SourceAccount`/`aws:SourceArn`条件
- **最小権限**: `bedrock:*`やAWS管理ポリシー`AmazonBedrockFullAccess`は未使用（Phase 7監査済み）。リソースタイプが存在しないBedrock/Marketplaceアクションのみ`Resource:"*"`を許容し、理由をコード内コメントと`NagSuppressions`に明記
- **cdk-nag**: `AwsSolutionsChecks`をApp全体とApplicationStage配下の両方に適用。全ての抑制(`NagSuppressions`)に理由を記載
- **監査**: CloudTrail Advanced Event SelectorsでBedrock KB/Guardrailのデータイベント（デフォルト非記録）を明示的に有効化

---

## 10. 設定値・パラメータ一覧

| パラメータ | 値 | 定義箇所 |
|---|---|---|
| リージョン | `ap-southeast-2` | `bin/metriever.ts` |
| CodeConnections対象リポジトリ | `uchidaatsuyastudy-hash/RAG_AWS_MIG` / `main` | `lib/pipeline-stack.ts` |
| Dev月次予算上限 | $20 | `lib/pipeline-stack.ts` |
| Prod月次予算上限 | $80 | `lib/pipeline-stack.ts` |
| Bedrockモデル | `au.anthropic.claude-sonnet-4-6`（地理的推論プロファイル） | `lib/stacks/agent-stack.ts`（`modelId?`で上書き可） |
| Agent最大トークン数 | 1024 | `lib/stacks/agent-stack.ts` |
| Agent最大ツールイテレーション | 4 | `lib/stacks/agent-stack.ts` |
| RetrievalService最大エージェントイテレーション | 5 | `lib/stacks/retrieval-service-stack.ts` |
| 取り込みデバウンス窓 | 最大300秒/100件 | `lib/stacks/ingestion-pipeline-stack.ts` |
| 取り込み安全網スケジュール | 毎日 JST 03:00 | `lib/stacks/ingestion-pipeline-stack.ts` |
| Step Functionsタイムアウト | 30分 | `lib/stacks/ingestion-pipeline-stack.ts` |
| CloudWatch Logs保持期間 | 1ヶ月（全Lambda/Guardrail関連ログ） | 各スタック |

---

## 11. 既知の制約・未実装機能

1. **AgentCore Harness不使用**: 実装時点でCloudFormation/CDK未対応（Gateway/Runtime/Memory/Evaluation/Policyは対応）のため、Bedrock Converse(tool use)による自前実装（`lambda/agent/index.ts`）で代替。Harnessのネイティブ対応が追加され次第、移行を検討
2. **AgentCore Evaluations不使用**: 上記に伴い、エージェントの自動品質評価（LLM-as-judge）は未導入。CloudTrailデータイベント＋CloudWatchメトリクス/アラームで代替
3. **ナレッジベースの画像抽出有効化による取り込み遅延**: ユーザー判断により画像抽出は有効のまま維持。ドキュメントによっては取り込みに数時間かかる場合がある（`progress.md`§4参照）
4. **AWS Marketplaceサブスクリプション**: Anthropicモデルの初回利用には、アカウント側でコンソール（Playground等）からの一度の呼び出しによるサブスクリプション完了が必要（IAM権限だけでは自動化しきれない。`progress.md`§8.6参照）
5. **SmokeTestステージが未実装**: `devStage.addPost(new ShellStep('SmokeTest', ...))`は現状プレースホルダのecho文のみで、実際のRAG動作確認は行っていない（手動で`aws lambda invoke`により実施）
6. **公開APIエンドポイント未実装**: API Gateway等は本仕様の対象外。現状は`aws lambda invoke`によるCLI呼び出しのみ

---

## 12. 関連ドキュメント

- `docs/progress.md` — 学習用の構築経緯・サービス解説・障害対応記録
- `docs/runbook.md` — 運用手順（Prod昇格、ロールバック、障害対応、コスト確認、動作確認コマンド）
- `C:\Users\LF83993\.claude\plans\cozy-crunching-hammock.md` — 初期実装計画書（本仕様書は実装後の逆生成であり、計画書との差分は`progress.md`に記録）
