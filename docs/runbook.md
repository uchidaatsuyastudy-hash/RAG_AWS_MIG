# Metriever 運用Runbook

## 1. Prodへの昇格（Manual Approval）

1. AWSコンソール → CodePipeline → `Metriever-Pipeline`
2. `Prod`ステージの`PromoteToProd`アクションで **Review** → コメントを入力して **Approve**
3. または CLI:
   ```powershell
   aws codepipeline get-pipeline-state --name Metriever-Pipeline --region ap-southeast-2 `
     --query "stageStates[?stageName=='Prod'].actionStates[?actionName=='PromoteToProd'].latestExecution.token" --output text
   aws codepipeline put-approval-result --pipeline-name Metriever-Pipeline --stage-name Prod `
     --action-name PromoteToProd --result "summary=Dev検証OK,status=Approved" --token <上記のtoken> --region ap-southeast-2
   ```

## 2. ロールバック手順

- **コード起因の不具合**: 直前の正常なコミットに`git revert`してpush。パイプラインが自動で以前の状態に再デプロイする
- **特定スタックだけ巻き戻したい**: CloudFormationコンソールで対象スタック（例: `Dev-Metriever-KnowledgeBase`）を選択し、イベント履歴から直前の成功したスタック更新を確認。個別のロールバックは原則パイプライン経由の再デプロイで対応し、コンソールからの直接変更は避ける

## 3. 取り込みジョブが失敗/スタックしたときの対応

1. `aws bedrock-agent get-ingestion-job --knowledge-base-id <KB_ID> --data-source-id <DS_ID> --ingestion-job-id <JOB_ID> --region ap-southeast-2` で状態確認
2. `IN_PROGRESS`のまま長時間（目安: 30分以上）進捗がない場合は `stop-ingestion-job` を試す
3. `STOPPING`からも応答がない場合は、該当の`Metriever-KnowledgeBase`スタックを削除して再作成する（本プロジェクトで実際に発生した事象。詳細は`progress.md`参照）:
   ```powershell
   aws cloudformation update-termination-protection --stack-name <Env>-Metriever-KnowledgeBase --no-enable-termination-protection --region ap-southeast-2
   aws cloudformation delete-stack --stack-name <Env>-Metriever-KnowledgeBase --region ap-southeast-2
   # 削除完了後、パイプラインを再実行するか新しいコミットをpushして再作成
   aws codepipeline start-pipeline-execution --name Metriever-Pipeline --region ap-southeast-2
   ```
4. `Metriever-IngestionFailureTopic`(SNS)に登録したメールアドレスにも失敗通知が届く

## 4. コスト確認

- AWS Budgets: Dev($20/月)・Prod($80/月)のアラートを50/80/100%で設定済み。閾値超過時は`FoundationStack`作成時に指定したメールアドレスに通知
- Cost Explorerで`Project: Metriever`タグによる絞り込みが可能（全スタックにタグ付与済み）
- FREEプランの残高確認: `aws freetier get-account-plan-state`

## 5. ナレッジベース/エージェントの動作確認

```powershell
# 検索のみ(Lambda経由でAgenticRetrieveStreamを呼ぶ)
aws lambda invoke --function-name <RetrievalService関数名> --payload '{"question":"What are the pillars of the AWS Well-Architected Framework?"}' --cli-binary-format raw-in-base64-out out.json --region ap-southeast-2
Get-Content out.json

# エージェント経由(RAG/一般知識の振り分け込み)
aws lambda invoke --function-name <Agent関数名> --payload '{"question":"富士山の標高は？"}' --cli-binary-format raw-in-base64-out out.json --region ap-southeast-2
Get-Content out.json
```

## 6. セキュリティ・IAM

- 全スタックで`bedrock:*`や`AmazonBedrockFullAccess`等の過度に広い権限は未使用（Phase 7監査済み）
- 新しいcdk-nag指摘が出た場合は、まず設定変更での解消を検討し、CDK/AWS側の制約で解消不能な場合のみ`NagSuppressions`で理由を明記して抑制する
- `KnowledgeBaseRole`等のBedrockサービスロールは`aws:SourceAccount`/`aws:SourceArn`によるconfused deputy対策済み

## 7. 既知の制約

- AgentCore Harnessは本プロジェクト作成時点でCDK/CloudFormation未対応のため、`AgentStack`はBedrock Converse(tool use)による自前実装で代替している（`lambda/agent/index.ts`参照）。将来Harnessのネイティブ対応が追加された場合は移行を検討する
- AgentCore Evaluationsは、エージェントがAgentCore Runtime/Harnessとして登録されていることを前提とする機能のため、上記の理由から本プロジェクトでは未導入。CloudTrailデータイベント記録とCloudWatchメトリクス/アラームで代替している
- ナレッジベースの画像抽出は有効のままのため、ドキュメントによっては取り込みに数時間かかる場合がある（原因分析は`progress.md`参照）
