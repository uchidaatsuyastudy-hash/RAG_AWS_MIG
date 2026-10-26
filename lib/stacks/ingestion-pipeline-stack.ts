import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import { NagSuppressions } from 'cdk-nag';

export interface IngestionPipelineStackProps extends cdk.StackProps {
  /** Change-notification queue, created in DataStack alongside the bucket it
   * receives events from (see DataStack for why). */
  readonly changeQueue: sqs.IQueue;
  readonly dataKey: kms.IKey;
  readonly knowledgeBaseId: string;
  readonly dataSourceId: string;
  readonly failureAlertEmail?: string;
}

/**
 * Debounced, auto-recovering ingestion trigger for the Managed Knowledge Base.
 *
 * Design note (learned from manually operating the KB in Phase 2): Bedrock's
 * StartIngestionJob already performs its own incremental diffing internally
 * (new/modified/deleted document counts are returned per job) — so unlike the
 * original plan, this stack does NOT maintain a separate DynamoDB hash-tracking
 * table. S3 changes are debounced through SQS + an EventBridge Pipe (batching
 * window) straight into a Step Functions orchestration that starts the job,
 * polls it to completion, and alerts on failure. A daily schedule re-triggers
 * ingestion unconditionally as a safety net for any missed S3 events.
 */
export class IngestionPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IngestionPipelineStackProps) {
    super(scope, id, props);

    const changeQueue = props.changeQueue;

    const failureTopic = new sns.Topic(this, 'IngestionFailureTopic', { masterKey: props.dataKey });
    if (props.failureAlertEmail) {
      failureTopic.addSubscription(new subscriptions.EmailSubscription(props.failureAlertEmail));
    }

    const kbArn = `arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`;

    // AWS SDK service integrations (stable, service-documented ASL resource
    // ARNs) rather than a dedicated L2 task construct — kept independent of
    // any particular CDK version's task-construct surface.
    const startJob = new sfn.CustomState(this, 'StartIngestionJob', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:bedrockagent:startIngestionJob',
        Parameters: {
          KnowledgeBaseId: props.knowledgeBaseId,
          DataSourceId: props.dataSourceId,
        },
        ResultPath: '$.startResult',
      },
    });

    const getJob = new sfn.CustomState(this, 'GetIngestionJob', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:bedrockagent:getIngestionJob',
        Parameters: {
          KnowledgeBaseId: props.knowledgeBaseId,
          DataSourceId: props.dataSourceId,
          'IngestionJobId.$': '$.startResult.IngestionJob.IngestionJobId',
        },
        ResultPath: '$.pollResult',
      },
    });

    const wait = new sfn.Wait(this, 'Wait30Seconds', { time: sfn.WaitTime.duration(cdk.Duration.seconds(30)) });
    const succeed = new sfn.Succeed(this, 'IngestionSucceeded');
    const fail = new sfn.Fail(this, 'IngestionFailed');
    const notifyFailure = new sfn.CustomState(this, 'NotifyFailure', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::sns:publish',
        Parameters: {
          TopicArn: failureTopic.topicArn,
          'Message.$': '$',
        },
        ResultPath: '$.notifyResult',
      },
    });

    const choice = new sfn.Choice(this, 'JobComplete?')
      .when(sfn.Condition.stringEquals('$.pollResult.IngestionJob.Status', 'COMPLETE'), succeed)
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals('$.pollResult.IngestionJob.Status', 'FAILED'),
          sfn.Condition.stringEquals('$.pollResult.IngestionJob.Status', 'STOPPED'),
        ),
        notifyFailure.next(fail),
      )
      .otherwise(wait);

    // A job already in flight (ConflictException, e.g. from the previous
    // event's run still polling) is not a failure — let the existing job run.
    startJob.addCatch(succeed, { errors: ['BedrockAgent.ConflictException'], resultPath: '$.error' });

    const definition = startJob.next(wait).next(getJob).next(choice);

    const stateMachine = new sfn.StateMachine(this, 'IngestionOrchestration', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(30),
    });
    stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob'],
        resources: [kbArn],
      }),
    );
    failureTopic.grantPublish(stateMachine);

    // EventBridge Pipe: debounce S3-change events from SQS into a single
    // state-machine execution per batching window, instead of one execution
    // per object change.
    const pipeRole = new iam.Role(this, 'PipeRole', { assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com') });
    changeQueue.grantConsumeMessages(pipeRole);
    stateMachine.grantStartExecution(pipeRole);

    new pipes.CfnPipe(this, 'ChangeDebouncePipe', {
      roleArn: pipeRole.roleArn,
      source: changeQueue.queueArn,
      sourceParameters: {
        sqsQueueParameters: { batchSize: 100, maximumBatchingWindowInSeconds: 300 },
      },
      target: stateMachine.stateMachineArn,
      targetParameters: {
        stepFunctionStateMachineParameters: { invocationType: 'FIRE_AND_FORGET' },
      },
    });

    // Daily safety net: re-run ingestion unconditionally in case an S3 event
    // was ever missed (Lambda outage, console-side object changes, etc).
    new scheduler.Schedule(this, 'DailyReconciliation', {
      schedule: scheduler.ScheduleExpression.cron({ hour: '18', minute: '0' }), // 03:00 JST
      target: new schedulerTargets.StepFunctionsStartExecution(stateMachine, {}),
    });

    new cloudwatch.Alarm(this, 'IngestionFailedAlarm', {
      metric: stateMachine.metricFailed(),
      threshold: 1,
      evaluationPeriods: 1,
    }).addAlarmAction(new cwActions.SnsAction(failureTopic));

    NagSuppressions.addResourceSuppressions(
      pipeRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: "grantConsumeMessages()/grantStartExecution() generate CDK's standard scoped wildcards limited to this specific queue/state machine ARN.",
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      stateMachine,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'bedrock:StartIngestionJob/GetIngestionJob are scoped to this specific Knowledge Base ARN; no wildcard resource is used.',
        },
        {
          id: 'AwsSolutions-SF1',
          reason: 'Execution logging is deferred to Phase 6 (observability), which adds CloudWatch Logs with a customer-managed KMS key across all stacks at once.',
        },
        {
          id: 'AwsSolutions-SF2',
          reason: 'X-Ray tracing is deferred to Phase 6 (observability) alongside the rest of the tracing/evaluation rollout.',
        },
      ],
      true,
    );
  }
}
