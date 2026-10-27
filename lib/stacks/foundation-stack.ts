import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { NagSuppressions } from 'cdk-nag';

export interface FoundationStackProps extends cdk.StackProps {
  /** Email address to receive AWS Budgets alerts. If omitted, the budget is not created. */
  readonly budgetAlertEmail?: string;
  /** Monthly budget limit in USD. Defaults to the FREE plan credit of $100. */
  readonly monthlyBudgetLimitUsd?: number;
}

/**
 * Shared, rarely-changing foundation: KMS keys reused by other stacks for
 * log/data encryption, and account-level cost guardrails.
 */
export class FoundationStack extends cdk.Stack {
  public readonly logsKey: kms.Key;
  public readonly dataKey: kms.Key;

  constructor(scope: Construct, id: string, props: FoundationStackProps = {}) {
    super(scope, id, props);

    this.logsKey = new kms.Key(this, 'LogsKey', {
      alias: 'metriever/logs',
      description: 'CMK for CloudWatch Logs, CloudTrail, and Bedrock data-event encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.logsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsRegion',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );
    // The CDK Trail L2 construct only auto-grants KMS key permissions to
    // CloudTrail when it creates the key itself; for an externally-supplied
    // key (this one, shared across stacks) that grant must be added here.
    this.logsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudTrailAccount',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
          ArnLike: {
            'kms:EncryptionContext:aws:cloudtrail:arn': `arn:${this.partition}:cloudtrail:${this.region}:${this.account}:trail/*`,
          },
        },
      }),
    );

    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: 'metriever/data',
      description: 'CMK for S3, DynamoDB, SNS, and Secrets Manager encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    if (props.budgetAlertEmail) {
      const alertTopic = new sns.Topic(this, 'BudgetAlertTopic', {
        displayName: 'Metriever budget alerts',
        masterKey: this.dataKey,
      });
      alertTopic.addSubscription(new subscriptions.EmailSubscription(props.budgetAlertEmail));

      const limit = props.monthlyBudgetLimitUsd ?? 100;
      new budgets.CfnBudget(this, 'MonthlyCostBudget', {
        budget: {
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: limit, unit: 'USD' },
        },
        notificationsWithSubscribers: [50, 80, 100].map((thresholdPercent) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: thresholdPercent,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetAlertEmail! }],
        })),
      });

      NagSuppressions.addResourceSuppressions(alertTopic, [
        {
          id: 'AwsSolutions-SNS2',
          reason: 'Topic is encrypted with a customer-managed KMS key (dataKey); rule flags missing AWS-managed default only.',
        },
      ]);
    } else {
      cdk.Annotations.of(this).addWarning(
        'FoundationStack: budgetAlertEmail not provided — skipping AWS Budgets setup. ' +
          "Pass it via CDK context: `cdk deploy -c budgetAlertEmail=you@example.com`.",
      );
    }
  }
}
