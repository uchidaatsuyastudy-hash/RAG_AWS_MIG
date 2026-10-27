import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FoundationStack } from '../stacks/foundation-stack';
import { DataStack } from '../stacks/data-stack';
import { KnowledgeBaseStack } from '../stacks/knowledge-base-stack';
import { IngestionPipelineStack } from '../stacks/ingestion-pipeline-stack';
import { RetrievalServiceStack } from '../stacks/retrieval-service-stack';
import { GuardrailStack } from '../stacks/guardrail-stack';
import { AgentStack } from '../stacks/agent-stack';
import { ObservabilityStack } from '../stacks/observability-stack';

export interface ApplicationStageProps extends cdk.StageProps {
  /** Lowercase environment name (e.g. 'dev', 'prod'); used to keep
   * stage-shared resource names (KMS aliases, etc.) unique across stages. */
  readonly envName: string;
  /** Email address to receive AWS Budgets alerts for this stage's spend. */
  readonly budgetAlertEmail?: string;
  readonly monthlyBudgetLimitUsd?: number;
  /** Email address to receive ingestion-failure alerts for this stage. */
  readonly ingestionFailureAlertEmail?: string;
}

/**
 * Wraps every application stack for one environment (Dev or Prod). CDK
 * Pipelines deploys one instance of this Stage per environment; stack IDs
 * are automatically prefixed with the Stage name (e.g. `Dev-Metriever-Foundation`).
 */
export class ApplicationStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: ApplicationStageProps) {
    super(scope, id, props);

    // cdk-nag Aspects added at the App level do not automatically propagate
    // into nested Stages (a CDK Pipelines-specific gotcha) — apply here too.
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    const foundation = new FoundationStack(this, 'Metriever-Foundation', {
      envName: props.envName,
      budgetAlertEmail: props.budgetAlertEmail,
      monthlyBudgetLimitUsd: props.monthlyBudgetLimitUsd,
    });

    const data = new DataStack(this, 'Metriever-Data', {
      dataKey: foundation.dataKey,
    });

    const kb = new KnowledgeBaseStack(this, 'Metriever-KnowledgeBase', {
      rawDocsBucket: data.rawDocsBucket,
      dataKey: foundation.dataKey,
      envName: props.envName,
    });

    const ingestion = new IngestionPipelineStack(this, 'Metriever-IngestionPipeline', {
      changeQueue: data.changeQueue,
      dataKey: foundation.dataKey,
      knowledgeBaseId: kb.knowledgeBaseId,
      dataSourceId: kb.dataSourceId,
      failureAlertEmail: props.ingestionFailureAlertEmail,
    });

    const retrievalService = new RetrievalServiceStack(this, 'Metriever-RetrievalService', {
      knowledgeBaseIds: [kb.knowledgeBaseId],
      logsKey: foundation.logsKey,
    });

    const guardrail = new GuardrailStack(this, 'Metriever-Guardrail', {
      dataKey: foundation.dataKey,
      envName: props.envName,
    });

    const agent = new AgentStack(this, 'Metriever-Agent', {
      retrievalFunction: retrievalService.retrievalFunction,
      guardrailId: guardrail.guardrailId,
      guardrailVersion: guardrail.guardrailVersion,
      logsKey: foundation.logsKey,
    });

    new ObservabilityStack(this, 'Metriever-Observability', {
      logsKey: foundation.logsKey,
      knowledgeBaseId: kb.knowledgeBaseId,
      guardrailId: guardrail.guardrailId,
      retrievalFunction: retrievalService.retrievalFunction,
      agentFunction: agent.agentFunction,
      ingestionStateMachine: ingestion.stateMachine,
      envName: props.envName,
    });
  }
}
