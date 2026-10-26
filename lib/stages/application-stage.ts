import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FoundationStack } from '../stacks/foundation-stack';
import { DataStack } from '../stacks/data-stack';
import { KnowledgeBaseStack } from '../stacks/knowledge-base-stack';

export interface ApplicationStageProps extends cdk.StageProps {
  /** Email address to receive AWS Budgets alerts for this stage's spend. */
  readonly budgetAlertEmail?: string;
  readonly monthlyBudgetLimitUsd?: number;
}

/**
 * Wraps every application stack for one environment (Dev or Prod). CDK
 * Pipelines deploys one instance of this Stage per environment; stack IDs
 * are automatically prefixed with the Stage name (e.g. `Dev-Metriever-Foundation`).
 */
export class ApplicationStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: ApplicationStageProps = {}) {
    super(scope, id, props);

    // cdk-nag Aspects added at the App level do not automatically propagate
    // into nested Stages (a CDK Pipelines-specific gotcha) — apply here too.
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    const foundation = new FoundationStack(this, 'Metriever-Foundation', {
      budgetAlertEmail: props.budgetAlertEmail,
      monthlyBudgetLimitUsd: props.monthlyBudgetLimitUsd,
    });

    const data = new DataStack(this, 'Metriever-Data', {
      dataKey: foundation.dataKey,
    });

    new KnowledgeBaseStack(this, 'Metriever-KnowledgeBase', {
      rawDocsBucket: data.rawDocsBucket,
      dataKey: foundation.dataKey,
    });
  }
}
