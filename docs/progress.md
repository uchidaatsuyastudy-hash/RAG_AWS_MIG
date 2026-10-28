# Metriever AWS移行プロジェクト — 学習用ドキュメント

最終更新: 2026-10-28（§8.6 スモークテストで発見した6つの不具合をすべて解消、Dev環境でのエンドツーエンド動作確認を追記）

このドキュメントは、進捗記録であると同時に「何を」「なぜ」「どう」作っているかを、AWSの各サービスに詳しくない人でも読めるように解説した学習用テキストです。

---

## 1. このプロジェクトは何を作っているのか

### 1.1 もともとの題材

`Metriever/PDF/` には、LangChain/LangGraphというPythonのライブラリを使ってRAG（Retrieval Augmented Generation＝検索拡張生成）システムを作るための技術解説資料が7本ある。RAGとは、「ChatGPTのような生成AIに、社内文書などの外部データを検索させてから回答させる」仕組みのこと。生成AI単体では知らない情報（自社の規定やマニュアルなど）について、正確な回答をさせるために使われる。

### 1.2 このプロジェクトでやっていること

その7本の資料が実現している機能を、**LangChainを自前のPythonコードで組む代わりに、AWSのマネージドサービス（AWSが用意してくれる既製の部品）を組み合わせて再現する**。さらに、作ったインフラを「コードとして」管理し（IaC = Infrastructure as Code）、変更を安全に・自動的に本番環境へ反映できる仕組み（CI/CDパイプライン）まで作り込む。

一言でいうと：**「資料を読んで理解する」から「同じことをAWS上で実際に動かす」へのステップアップ**。

---

## 2. 使っているAWSサービスの役割（初学者向け解説）

このプロジェクトでは数多くのAWSサービスを組み合わせている。それぞれ「何をしてくれる部品なのか」を日常の例えとあわせて説明する。

| サービス | 何をするものか | 例えるなら |
|---|---|---|
| **Amazon S3** | ファイルを保存する倉庫。今回はPDF等の元ドキュメントを置く場所として使用 | 本棚 |
| **Amazon Bedrock Knowledge Base** | 倉庫（S3）にある文書を読み込み、AIが検索しやすい形に変換して保管する専門業者 | 図書館の司書（詳細は3章） |
| **AWS KMS** | データを暗号化するための「鍵」を管理するサービス | 金庫の鍵の管理人 |
| **Amazon SQS** | メッセージ（「ファイルが変わったよ」等の通知）を一時的に貯めておく郵便受け | 郵便受け |
| **AWS Step Functions** | 複数の処理ステップを順番通りに実行・管理する仕組み（「まずAをやって、次にBを確認して、だめならCする」という手順書そのもの） | 業務フローチャートの実行役 |
| **Amazon EventBridge Pipes** | SQSに溜まったメッセージを、一定時間分まとめてStep Functionsに流す「仕分け係」 | 郵便局の集荷担当（まとめて1回で配達） |
| **Amazon EventBridge Scheduler** | 「毎日3時に実行」のような時間指定の自動実行（目覚まし時計） | 目覚まし時計 |
| **Amazon SNS** | 「失敗したよ」等の通知をメールなどに送る仕組み | 緊急連絡網 |
| **Amazon CloudWatch** | システムの状態を監視し、異常があればアラームを鳴らす | 見張り番 |
| **AWS CodePipeline / CodeBuild / CodeConnections** | GitHubにコードをpushすると、自動でビルド・テスト・デプロイしてくれる一連の工場ライン | 自動組み立てライン |
| **AWS CloudFormation** | 「こういうインフラが欲しい」という設計図（テンプレート）を渡すと、その通りにAWS上にリソースを作ってくれる仕組み。CDKはこの設計図をTypeScriptで書けるようにする道具 | 建築の施工図＋施工会社 |
| **AWS IAM** | 「誰が」「何に対して」「何をしてよいか」を管理する権限システム | 社員証とセキュリティゲート |

---

## 3. Amazon Bedrock Knowledge Base は具体的に何をしているのか

これが今回の中核なので、特に詳しく説明する。

### 3.1 作成時（`create-knowledge-base`）

「ナレッジベースを作る」とは、検索エンジンの“器”を1つ用意すること。この時点では中身は空っぽ。

### 3.2 データソースを接続する（`create-data-source`）

「どこのS3バケットを見に行けばいいか」をナレッジベースに教える。これも、ドアを設置するだけで、まだ中の文書は読み込まれていない。

### 3.3 取り込みジョブ（`start-ingestion-job`）を実行すると内部で起きていること

ここがAIが「賢くなる」実際の処理で、裏側では以下のパイプラインが動いている（Managed Knowledge Baseの場合、すべてAWSが自動で行う）。

```
① S3から対象ファイルを取得
       ↓
② ファイルを解析（パース）
   - PDFの場合、ページごとにテキスト・表・画像の位置を認識する
       ↓
③（オプション）画像の内容をAIで説明文化する「メディア抽出」
   - 図やグラフが「何を示しているか」をAIモデル（画像を理解できるモデル）に読み取らせ、
     テキストの説明として追加する
       ↓
④ テキストを「チャンク」という小さな単位に分割する
   - 1つのチャンクは数百〜1000文字程度。後で検索するときの最小単位になる
       ↓
⑤ 各チャンクを「埋め込みベクトル」に変換する（Embedding）
   - 文章の意味を、数百〜数千個の数字の列（ベクトル）として表現する
   - 意味が近い文章ほど、ベクトル同士の距離が近くなる
       ↓
⑥ ベクトルとテキストを、検索用のデータベース（ベクトルストア）に保存する
       ↓
⑦ ジョブのステータスが COMPLETE になる
```

Managed Knowledge Base（マネージドKB）を選んだ理由は、②〜⑥の処理（パース・チャンク分割・埋め込みモデルの選定・ベクトルストアの構築）を**すべてAWSが自動でやってくれる**ため。自分で選ぶ・管理する必要があるのは「どのS3バケットを見るか」だけで済む。

### 3.4 検索時（`Retrieve` / `AgenticRetrieveStream`）

ユーザーの質問も同じように埋め込みベクトルに変換し、保存されているチャンクのベクトルと「意味の近さ」を比較して、関連度の高いチャンクを取り出す。これが検索結果として返ってくる。

---

## 4. なぜ「2つのドキュメントの同期に2〜3時間」かかったのか

実際に発生した事象: AWS Well-Architected Frameworkのホワイトペーパー（約14MB）と論文"Attention Is All You Need"（約2MB）、合計たった2つのPDFファイルの取り込みに、2〜3時間という異常に長い時間がかかった。

### 4.1 考えられる原因（確度が高い順）

**① 画像抽出（メディア抽出）がデフォルトで有効になっていたこと（最有力）**

データソースの設定を確認したところ、以下の設定が**何も指定していないのにデフォルトでONになっていた**ことが判明している。

```json
"mediaExtractionConfiguration": {
  "imageExtractionConfiguration": { "imageExtractionStatus": "ENABLED" }
}
```

これは上記3.3節の「③ メディア抽出」のステップで、PDF内の**すべての図・グラフ・イラストを1枚ずつAIモデルに読み込ませて説明文を生成する**処理。

- AWS Well-Architected Frameworkは120ページ以上あり、図表が非常に多い資料
- 論文側も数式・グラフを含む
- 画像1枚ごとにAIモデルを呼び出すため、画像の枚数分だけ処理が直列に（＝1枚ずつ順番に）積み重なり、時間がかかったと考えられる

**② Managed Knowledge Base自体が比較的新しいサービスであること**

AWSが2025年以降に提供を広げている新しいマネージド機能であり、特に`ap-southeast-2`（シドニー）のような、米国本土以外のリージョンでは、裏側の処理基盤のキャパシティや最適化が十分でない可能性がある。これは実際に、過去の取り込みジョブが`IN_PROGRESS`のまま約19分進捗ゼロで固まり、`stop-ingestion-job`を実行しても`STOPPING`のまま応答しなくなるという明確な異常が発生したことからも裏付けられる（最終的にはナレッジベースごと作り直すことで解消した）。

**③ 裏付けとなるログがまだない**

CloudTrailのデータイベント記録やCloudWatch Logsをこの時点ではまだ有効化していなかったため（Phase 6で対応予定）、①②はいずれも状況証拠からの推測であり、確定した原因ではない。

### 4.2 対応方針（ユーザー判断: 現状維持）

画像抽出を無効化すれば時間短縮が見込めると提案したが、**ユーザーの判断により画像抽出は有効のまま維持する**ことになった（図表の内容も検索対象にしたいため）。したがって、取り込みに数時間かかること自体は許容し、Phase 4以降の検証では「取り込みには時間がかかるもの」という前提でスケジュールを組む。原因の裏付け（CloudTrail/CloudWatch Logsでの確認）はPhase 6の観測性強化で改めて行う。

---

## 5. 全体アーキテクチャ（現時点）

```
GitHub(main) --push--> CodeConnections --> CodePipeline(Metriever-Pipeline)
                                              │
                                   Source → Build(Synth) → UpdatePipeline(SelfMutate)
                                              │
                                              ▼
                                       Dev Stage（1回のデプロイで全スタックを同時構築）
                                   ┌─────────────────────────────────────┐
                                   │ Metriever-Foundation                  │
                                   │   KMS鍵（ログ用/データ用）, Budgets    │
                                   │                                       │
                                   │ Metriever-Data                        │
                                   │   S3生データバケット(暗号化・ログ付)   │
                                   │   変更通知SQSキュー＋DLQ               │
                                   │                                       │
                                   │ Metriever-KnowledgeBase                │
                                   │   Bedrock Managed Knowledge Base       │
                                   │   S3マネージドコネクタ(DataSource)     │
                                   │                                       │
                                   │ Metriever-IngestionPipeline             │
                                   │   EventBridge Pipe(SQSを5分でバッチ化) │
                                   │   Step Functions(取り込みジョブの監視) │
                                   │   SNS(失敗通知) + CloudWatchアラーム   │
                                   │   EventBridge Scheduler(毎日の安全網) │
                                   └─────────────────────────────────────┘
                                              │
                                     手動承認(PromoteToProd)
                                              │
                                              ▼
                                       Prod Stage（承認後、同じ構成をもう一式）
```

**ポイント**: 「1回のデプロイでまとめて構築する」というのはすでに実現している構成。コードを書き終えてから1回だけ`git push`すれば、パイプラインが1回走り、以下の8スタックが1回の実行の中で連続して全部デプロイされる。

```
Dev / Prod Stage（最終形）
├── Metriever-Foundation       KMS鍵, Budgets
├── Metriever-Data             S3生データバケット, 変更通知SQS+DLQ
├── Metriever-KnowledgeBase    Bedrock Managed Knowledge Base
├── Metriever-IngestionPipeline  取り込み自動化(Step Functions等)
├── Metriever-RetrievalService  AgenticRetrieveStreamラッパーLambda
├── Metriever-Guardrail         コンテンツフィルタ・PIIマスキング
├── Metriever-Agent             RAG/一般知識ルーティングLambda
└── Metriever-Observability     CloudTrail・CloudWatchダッシュボード
```

---

## 6. これまでに作ったもの（Phase 0〜3、構築ログ）

### Phase 0: プロジェクトの土台作り

**やったこと**
- `Metriever/infra/`にCDK（TypeScript）のプロジェクトを新規作成
- Gitが端末に入っていなかったのでwingetでインストール
- AWSアカウントにCDKの「ブートストラップ」を実行（CDKが使う共通の置き場所・権限を用意する初回儀式）
- `FoundationStack`を作成：KMSの鍵を2つ（ログ用・データ用）、コストが$100の予算を超えそうになったらメール通知するBudgets設定、セキュリティチェックツール（cdk-nag）の導入

**学んだこと**: `cdk-nag`という「作ろうとしているインフラがセキュリティのベストプラクティスに沿っているか自動チェックしてくれるツール」の最新版(v3)が、使い方を根本から変えるアップデートをしていて、想定通りに動かなかった。安定して動く一つ前のバージョン(v2.38.2)に固定して解決。

### Phase 1: 自動デプロイの仕組み（CI/CDパイプライン）作り

**やったこと**
- GitHubとAWSを連携させる「CodeConnections」を設定（ブラウザでGitHubにログインして許可する作業が必要）
- コードをpushすると自動でビルド・テスト・デプロイが走る「CodePipeline」を構築

**学んだこと（失敗談）**: ローカルのパソコンで新しいコードを書いた後、**GitHubにpushするのを忘れたまま**「とりあえずAWSにデプロイしてみよう」をやってしまい、パイプラインの「自己更新」ステップが「GitHub上の（古い）コードには存在しないはずのスタック名」を探しに行って失敗した。CI/CDパイプラインは**GitHub上のコードを基準に動く**という、基本だが重要な性質を実地で確認した。

### Phase 2: ナレッジベース（検索エンジン）の構築

**やったこと**
- `DataStack`：S3バケットを作成（暗号化、バージョン管理、アクセスログ記録）
- `KnowledgeBaseStack`：Bedrock Managed Knowledge Baseを作成し、そのS3バケットをデータソースとして接続

**学んだこと（失敗談と対処）**:
1. 当初、社内の学習用PDF資料をテストデータとしてアップロードしたが、ユーザーからの指摘で「ローカル→クラウドへのデータ転送は必ず事前確認すべき」というルールに違反していたことが判明。該当ファイルを削除し、インターネット上の公開ドキュメント（AWS公式資料と論文）に差し替えた
2. 取り込みジョブが延々と終わらずスタックする事象が発生（詳細は4章）。最終的にナレッジベースを一度削除して作り直すことで解消した
3. ファイル名を日本語のままアップロードしたところ、文字コードの扱いの問題でS3上のファイル名が文字化けするトラブルも発生。英数字のファイル名に変更して解決

### Phase 3: データ取り込みの自動化

**やったこと**
- `IngestionPipelineStack`：S3に新しいファイルが置かれたら自動的に取り込みジョブが走る仕組みを構築
- 具体的には「S3への変更通知→SQSキューに溜める→5分ごとにEventBridge Pipeがまとめて取り出す→Step Functionsが取り込みジョブを開始して完了まで監視→失敗したらSNSでメール通知」という流れ
- 毎日決まった時刻にも無条件で同期する「安全網」のスケジュールも追加

**学んだこと（当初計画からの方針転換）**: 当初の計画書には「差分検知用にDynamoDBで変更履歴を記録する」という設計があったが、実際にBedrockの取り込みジョブのレスポンスを見ると、**新規・更新・削除されたドキュメント数を自分で勝手に判定して教えてくれる**ことが判明した。つまり「差分を自前で管理する」仕組みはAWSの機能と重複する無駄な実装だったため、計画を修正してシンプルな構成に変更した。**実際に動かしてみて初めて分かることがある**という良い例。

**学んだこと（設計上の制約）**: CDKでは、「S3バケットの変更をSQSに通知する」仕組みを、バケットとは別のスタックで作ろうとすると、「AとBが互いを必要とし合う」循環依存エラーが発生することがある。これを避けるため、通知を受け取るSQSキューは、バケットと同じ`DataStack`の中に置くという設計に修正した。

---

## 7. Phase 4〜7（フル仕様で実装・完了）

ユーザーの判断により、縮小版ではなく**計画書(`cozy-crunching-hammock.md`)通りのフル仕様**で実装した。Phase 0〜3と違い、Phase 4〜7は**コードを全部書き終えてから1回だけコミット・プッシュ**する方針で進めた（1回のパイプライン実行で8スタックすべてをまとめてデプロイするため）。

### Phase 4: 検索サービス

- `RetrievalServiceStack`：`AgenticRetrieveStream`を呼び出すLambda（Node.js/TypeScript）を実装
- このAPI1回の呼び出しで、質問の分解（Query Decomposition相当）、関連度による並び替え（Managed Reranking）、複数Knowledge Base横断検索が内部的に行われる。PDF資料の06章で自前実装されていたカスタムレトリーバーのロジックを、マネージドAPIの呼び出し1つに置き換えた形
- 呼び出すモデル（プランナー・埋め込み・リランキング）はAWS側が自動選択するため、IAM権限は「どのモデルを使うか指定できない」制約の中で、リージョン内のfoundation-model名前空間に絞った最小権限にしている

### Phase 5: コンテンツ安全性とエージェント的ルーティング

- `GuardrailStack`：有害コンテンツフィルタ（ヘイト・侮辱・性的・暴力・不正行為・プロンプトインジェクション）とPIIマスキング（メール・電話・氏名・住所・社会保障番号・クレジットカード番号）を設定
- `AgentStack`：「RAGで答えるべきか」「一般知識で答えてよいか」をAIが自律的に判断し、必要に応じて検索Lambdaを呼び出す、という振る舞いをBedrockの**Converse API（ツール呼び出し機能）**で実装

**重要な設計判断（当初計画からの変更）**: 当初の計画では「AgentCore Harness」というAWSのノーコード・エージェント実行基盤を使う想定だった。しかし実装時に確認したところ、Harnessは現時点でCloudFormation/CDKに対応しておらず（Gateway・Runtime・Memory・Evaluation・Policyは対応している一方、Harnessだけ未対応）、IaCで扱うには未文書化のAPIを直接叩くカスタムリソースを自作する必要があり、リスクと工数が見合わないと判断した。代わりに、AWSが公式に案内している「Converse APIのツール呼び出し機能＋Guardrail」という、より枯れた方法でエージェント的な振る舞いを実現した。機能的には「質問に応じてRAG検索するかどうかをAIが判断する」という目的を満たしている。

### Phase 6: 観測性

- `ObservabilityStack`：CloudTrailに「高度なイベントセレクター」を設定し、デフォルトでは記録されないBedrock Knowledge BaseとGuardrailへのアクセス（データイベント）を記録するようにした
- Lambda（検索・エージェント）とStep Functions（取り込みパイプライン）の呼び出し回数・エラー数・処理時間を1枚のCloudWatchダッシュボードにまとめ、エラー発生時のアラームも設定
- **当初計画からの変更**: 「AgentCore Evaluations」（AIによる自動採点機能）は、エージェントがAgentCore Runtime/Harnessとして登録されていることが前提の機能。Phase 5でHarnessを使わない判断をしたことに伴い、Evaluationsも今回は導入を見送り、CloudTrail+CloudWatchによるトレーシングで代替した

### Phase 7: 仕上げ

- 全スタックのIAMポリシーを目視監査。`bedrock:*`や`AmazonBedrockFullAccess`のような過度に広い権限が残っていないことを確認
- 運用Runbook（`docs/runbook.md`）を作成：Prod昇格手順、ロールバック手順、取り込みジョブ障害時の対応、コスト確認方法、動作確認コマンド、既知の制約をまとめた

---

## 8. CI/CDパイプラインとDev/Prod運用の詳細解説

ここまでの章で軽く触れてきた「パイプライン」と「Dev/Prod」について、実際に何が起きるのかをステップごとに詳しく解説する。パイプライン自体が実際に何度も壊れて直してきたので、その実例も合わせて載せる。

### 8.1 パイプラインとは何か、何のためにあるのか

**何もない状態**では、インフラを変更するたびに開発者が自分のPCから`cdk deploy`コマンドを手で打つことになる。これには次の問題がある。

- 手元の環境にしかない変更（pushし忘れ）をうっかりデプロイしてしまう（実際にPhase 1で発生。6章参照）
- 「テストを通してからデプロイする」「Devで確認してからProdに反映する」という手順を徹底する仕組みがない（人が忘れる）
- 誰が・いつ・何をデプロイしたかの記録が残りにくい

**CI/CDパイプライン**は、この手作業を「GitHubにコードをpushする」という1つの操作に一本化し、その後の「ビルド→テスト→デプロイ」を全部自動でやってくれる仕組み。今回は`aws-cdk-lib/pipelines`という、CDKのアプリ自体をパイプラインの形でデプロイできるライブラリ（CDK Pipelines）を使っている。

### 8.2 パイプラインの6つのステージ（`Metriever-Pipeline`）

実際にAWSコンソールやCLIで見えるステージは次の6つ。`aws codepipeline get-pipeline-state`で毎回確認しているのがこの構造。

```
① Source          : GitHub(main)にpushされたことを検知し、最新コードを取得
② Build           : CodeBuildで npm ci → npm run build → npm test → cdk synth を実行
                     （テストが1つでも落ちたら、ここで止まる＝Devにすら届かない）
③ UpdatePipeline  : 「パイプライン自身の定義」が変わっていないか確認し、変わっていれば
                     パイプラインを自己更新する（CDK Pipelinesの特徴。手で更新不要）
④ Assets          : Lambda関数のコード等、デプロイに必要な成果物をS3にアップロード
⑤ Dev             : Dev環境へ8スタックを順番にデプロイ（8.4節で詳細）
⑥ Prod            : 手動承認(PromoteToProd)を経て、Prod環境へ同じ8スタックをデプロイ
```

**ポイント**: ①〜④は「コードが正しく、デプロイできる状態か」を機械的に検証する工程で、人の判断は入らない。⑤Devまでは自動で進むが、⑥Prodに入る直前には必ず**人間が「Approve」ボタンを押す（または`put-approval-result`コマンドを叩く）**ステップが挟まる。これにより「DevでちゃんとテストしてからProdに反映する」という開発プロセスを、気合いではなく仕組みで強制している。

### 8.3 Dev環境とProd環境の違い

このプロジェクトでは、AWSアカウントもリージョンも**1つだけ**（新しいAWS体験のプロジェクト制約で複数リージョンが使えないため）。したがってDev/Prodの違いは「別のアカウント」ではなく、**同じアカウント内でスタック名のプレフィックスが違うだけ**。

| | Dev | Prod |
|---|---|---|
| スタック名の例 | `Dev-Metriever-Foundation` | `Prod-Metriever-Foundation` |
| 月間予算アラーム | $20 | $80 |
| デプロイのタイミング | pushのたびに自動 | 手動承認後 |
| 用途 | 動作確認・検証用 | 実際に使う本番用 |

`ApplicationStage`（`lib/stages/application-stage.ts`）という1つの「型」から、`new ApplicationStage(this, 'Dev', {...})`と`new ApplicationStage(this, 'Prod', {...})`のように、IDだけ変えて2回インスタンス化している。中身の8スタック構成は完全に同じコードが使われる（＝「Devで動いたものと全く同じ設計図でProdを作る」ことが保証される）。

### 8.4 Dev/Prodそれぞれでの8スタックのデプロイ順序

1つの環境（Dev or Prod）の中では、8つのスタックが依存関係の順番通りにデプロイされる（後のスタックが前のスタックの出力値、例えばKMS鍵のARNやナレッジベースIDを必要とするため）。

```
Foundation → Data → KnowledgeBase → IngestionPipeline
                                  → RetrievalService → Guardrail → Agent → Observability
```

それぞれのスタックのデプロイは、CloudFormationの中で「Prepare（変更内容の計算＝チェンジセット作成）」と「Deploy（実際に反映）」の2段階に分かれている。`get-pipeline-state`で見える`Metriever-XXX.Prepare` / `Metriever-XXX.Deploy`という表示はこれに対応する。

### 8.5 実際に発生した失敗と、そこから学んだこと（Dev/Prod分離特有の罠）

Phase 4〜7をまとめてデプロイした後、Devは成功したがProdで立て続けに失敗した。これは**Dev/Prodが「同じアカウント内の別スタック」である**という、このプロジェクト特有の構成に起因するもので、学びが大きいので詳しく残す。

**① Observabilityスタック: CloudTrailがKMS鍵を使えない**

- 症状: `Dev-Metriever-Observability`の作成が失敗（`CreateFailed`）
- 原因: CloudTrail（証跡）を、共有のKMS鍵（`FoundationStack`が作る`logsKey`）で暗号化する設定にしていたが、そのKMS鍵のポリシーには「CloudWatch Logsサービスがこの鍵を使ってよい」という許可しか書かれておらず、「CloudTrailサービスがこの鍵を使ってよい」という許可が抜けていた
- なぜ気づきにくいか: CDKの`Trail`という部品（L2コンストラクト）は、**自分でKMS鍵を新規作成した場合は**鍵のポリシーを自動で設定してくれるが、**既存の（他のスタックで作った）鍵を渡した場合は**その自動設定が働かない、という仕様がある。今回は複数のスタックでログ暗号化用に鍵を使い回していたため、この「落とし穴」にはまった
- 対処: `FoundationStack`のKMS鍵ポリシーに、CloudTrailサービスプリンシパル(`cloudtrail.amazonaws.com`)向けの許可を手動で追加した

**② Foundationスタック: KMSエイリアス名の衝突**

- 症状: Prodの`Metriever-Foundation`のチェンジセット作成が失敗（`ResourceExistenceCheck`フック失敗）
- 原因: KMS鍵の「エイリアス」（`metriever/logs`のような分かりやすい別名）を、Dev/Prod共通の固定文字列でコードに書いていた。**KMSのエイリアス名はアカウント全体・リージョン全体で重複できない**（CloudFormationのスタック単位ではない）ため、Devが先に`metriever/logs`を使ってしまうと、後から同じ名前でProdが作ろうとして衝突する
- 対処: `metriever/dev/logs`・`metriever/prod/logs`のように、環境名を名前に埋め込むよう修正（`envName`というプロパティを追加し、`ApplicationStage`から全スタックに渡す設計にした）

**③ Guardrail・Knowledge Base・CloudTrail・ダッシュボード: 同種の名前衝突が他にも4箇所**

- ②と全く同じ理由（名前がアカウント/リージョン単位で一意という制約）で、以下もDev/Prodで衝突することが判明し、同様に修正した
  - `GuardrailStack`のガードレール名
  - `KnowledgeBaseStack`のIAMロール名・Knowledge Base名・データソース名
  - `ObservabilityStack`のCloudTrail証跡名・CloudWatchダッシュボード名
- **教訓**: AWSのリソース名には、「CloudFormationのスタックの中でだけユニークであればよいもの」（ほとんどのリソース。何も指定しなければCDKが自動でユニークな物理名を生成してくれる）と、「アカウント全体・リージョン全体でユニークでなければならないもの」（KMSエイリアス、IAMロール名、Bedrock Guardrail/Knowledge Base名、CloudTrail証跡名、CloudWatchダッシュボード名など、名前を自分で明示的に指定する種類のリソースに多い）の2種類がある。**同じCDKコードをDev/Prodのように複数回デプロイする設計（Stageパターン）では、後者に該当する名前には必ず環境名などの識別子を含める必要がある**。この失敗が起きるまでは意識していなかった盲点だった

**④ 壊れたスタックの復旧パターン（`ROLLBACK_COMPLETE`）**

- 上記①〜③のような失敗が起きると、CloudFormationは作りかけのリソースを自動的に巻き戻す（ロールバック）が、スタック自体は`ROLLBACK_COMPLETE`という状態で残る
- `ROLLBACK_COMPLETE`状態のスタックは、**CloudFormationの仕様上そのまま更新できない**（「一度失敗した工事現場に、そのまま次の工事を重ねることはできない」イメージ）。必ず一度削除してから、同じCDKコードで作り直す必要がある
- 復旧の手順（今回4回実施）: `aws cloudformation delete-stack` → `aws cloudformation wait stack-delete-complete` → パイプラインを再実行（`retry-stage-execution`または新しいコミットのpush）
- この手順は`docs/runbook.md`の3章にも汎用的な対応手順として記載している

### 8.6 スモークテストで判明した一連の不具合と解決

Phase 4〜7のデプロイ成功後、実際にLambdaを呼び出すスモークテストを行ったところ、RetrievalService（検索のみ）は一発で正しく動作したが、Agent（RAG/一般知識の振り分け）では立て続けに4つの問題が見つかった。1つずつ切り分けて直していく過程を記録する。

**① IAMアクション名の誤記**: `bedrock-agent-runtime:AgenticRetrieveStream`という存在しない名前空間を指定していた。正しくは`bedrock:AgenticRetrieveStream`（`bedrock:Retrieve`と同じ名前空間）。AWS公式スキルの参照資料にもこの点の明記がなく、実際にLambdaを呼び出して初めて発覚した

**② `AgenticRetrieveStream`はリソース単位の権限指定に対応していない**: ①を直した後も同じエラーが継続。管理者ロール（`Resource: "*"`相当）では成功し、Knowledge Base ARNに絞った権限では失敗することを比較検証し、このアクションが`bedrock:CreateKnowledgeBase`などと同様に「リソースタイプなし＝`Resource: "*"`必須」のアクションだと判明。`bedrock:Retrieve`はリソース単位の指定を維持し、`bedrock:AgenticRetrieveStream`だけ`"*"`に分離した

**③ Claude Sonnet 4.6はオンデマンド（直接）呼び出し非対応**: Agent側のモデル呼び出しで`ValidationException`が発生。このモデルは「推論プロファイル」経由でのみ呼び出し可能だった。`au.anthropic.claude-sonnet-4-6`（オーストラリア域内＝ap-southeast-2/ap-southeast-4のみでルーティングされる地理的プロファイル）を採用し、`global.`（世界中にルーティングされうる）は意図的に避けた。IAM権限も「プロファイルのARN」と「実体のモデルARN（両リージョン分）」の両方が必要だった

**④ GuardrailのKMS鍵へのdecrypt権限漏れ**: ③を直した後、「ガードレールのKMS鍵にアクセスできない」エラー。`GuardrailStack`はFoundationStackの共有KMS鍵（`dataKey`）でガードレール設定を暗号化していたが、`AgentStack`側にその鍵への`kms:Decrypt`権限を渡し忘れていた（①②③と同種の「権限の渡し忘れ」パターン）

**⑤ Anthropicモデルの初回利用フォーム未提出**: ④を直した後、`ResourceNotFoundException`（use case詳細未提出）。AWSコンソールのBedrock Playgroundで一度Claudeモデルを開くとこのフォームが表示されるため、ユーザーに提出してもらった

**⑥ AWS Marketplaceサブスクリプション未完了（解消済み）**: ⑤の後、今度は「IAMロールにAWS Marketplaceアクション（`aws-marketplace:Subscribe`等）の権限がない」という`AccessDeniedException`。まずLambdaの実行ロールにこの権限を追加したが解消せず、さらに調査したところ、**管理者権限ロール(`AdministratorAccess`相当)でBedrock Playgroundから直接呼び出しても同じエラーが発生する**ことを確認した。これはIAMポリシーの不足ではなく、アカウント側でこのモデルのサブスクリプションがまだ完了していないことが原因と判断した。

AnthropicのClaudeモデルはAWS Marketplace経由で提供される従量課金製品であり、アカウントで初めて呼び出す際にBedrockが裏側で自動サブスクリプションを試みる。Lambda経由での呼び出しではこの自動サブスクリプションが完了しなかったため、Bedrockコンソールの**Playground**でClaude Sonnet 4.6を一度開いて対話したところ、サブスクリプションが完了し、以降はLambda経由の呼び出しも含めて正常に動作するようになった。一方、RetrievalService側の`AgenticRetrieveStream`が最初から問題なく動いたのは、内部で使うプランナー/埋め込み/リランクモデルの選定・呼び出しをAWS側が完全に代行しており、呼び出し元が自分でMarketplace製品をサブスクライブする必要がないためだと考えられる。

**最終確認**: サブスクリプション完了後、Agent Lambdaに一般知識質問（「富士山の標高は？」）とRAG質問（「What are the pillars of the AWS Well-Architected Framework?」）の両方を投げ、前者は「ナレッジベースには該当情報がないため一般知識で回答」という適切な判断、後者は「ナレッジベースから6つの柱を正しく回答（出典明記）」という適切な判断を、それぞれ`search_knowledge_base`ツールを実際に呼び出した上で行うことを確認した。これによりPhase 4〜7で構築した全機能（RetrievalService・Guardrail・Agent）がDev環境でエンドツーエンドに動作することが実証された。

### 8.7 なぜ「1回の修正→pushのたびにパイプラインが全部流れる」のか

このプロジェクトでは、インフラの設定ミスが見つかるたびに「コード修正→ビルド・テスト→コミット→push」を繰り返した。pushするたびにパイプラインの①Sourceから自動的に再始動し、②Build（テスト）を再度通過しないと③以降に進めない。これにより、「直したつもりが実は壊れている」状態のままDev/Prodに届いてしまうことを防いでいる。実際、本セッションでも複数回の失敗・修正・再pushのサイクルを経て、最終的にDev・Prod双方の全8スタックのデプロイに成功した。

---

## 9. 用語集（このドキュメントに出てきた言葉）

| 用語 | 意味 |
|---|---|
| RAG | Retrieval Augmented Generation。検索した情報をもとに生成AIが回答する仕組み |
| 埋め込み（Embedding） | 文章の意味を数値のベクトルに変換したもの |
| チャンク（Chunk） | 検索しやすいように文章を分割した小さな単位 |
| IaC（Infrastructure as Code） | インフラの構成をコードで記述し、再現可能にする手法 |
| CDK | IaCをTypeScript等のプログラミング言語で書けるようにするAWSのツール |
| CloudFormation | CDKが最終的に生成する、AWSへの指示書（テンプレート） |
| スタック（Stack） | CloudFormationで一括管理されるリソースのまとまり |
| CI/CD | コードの変更を自動でテスト・デプロイする仕組み（継続的インテグレーション/デリバリー） |
| cdk-nag | インフラコードのセキュリティ上の問題を自動検出するツール |

---

## 10. 参考資料

- 実装計画の全文: `C:\Users\LF83993\.claude\plans\cozy-crunching-hammock.md`
- PDF資料群の技術評価: 本セッションの会話履歴を参照
