import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FoundationStack } from '../stacks/foundation-stack';

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

    new FoundationStack(this, 'Metriever-Foundation', {
      budgetAlertEmail: props.budgetAlertEmail,
      monthlyBudgetLimitUsd: props.monthlyBudgetLimitUsd,
    });
  }
}
