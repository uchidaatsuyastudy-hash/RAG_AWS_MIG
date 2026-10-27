import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly logsKey: kms.IKey;
  readonly knowledgeBaseId: string;
  readonly guardrailId: string;
  readonly retrievalFunction: lambda.IFunction;
  readonly agentFunction: lambda.IFunction;
  readonly ingestionStateMachine: sfn.IStateMachine;
  /** Lowercase environment name (e.g. 'dev', 'prod'); CloudTrail trail names
   * and CloudWatch dashboard names are unique per account/Region, not per
   * stack. */
  readonly envName: string;
}

/**
 * CloudTrail data-event auditing + a CloudWatch dashboard across the agent
 * pipeline. Addresses the single biggest gap identified in the original PDF
 * resources' technical review: no tracing/evaluation of any kind. Full
 * AgentCore Evaluations (LLM-as-judge scoring) is deferred — it requires the
 * agent to be registered as an AgentCore Runtime/Harness resource, which
 * this project does not use (see lambda/agent/index.ts); this stack covers
 * what's achievable for a plain-Lambda agent: structural tracing via
 * CloudTrail + CloudWatch metrics/alarms.
 */
export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const trail = new cloudtrail.Trail(this, 'DataEventTrail', {
      trailName: `metriever-data-events-${props.envName}`,
      encryptionKey: props.logsKey,
      sendToCloudWatchLogs: true,
      cloudWatchLogsRetention: cdk.aws_logs.RetentionDays.ONE_MONTH,
    });

    const kbArn = `arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`;
    const guardrailArn = `arn:${this.partition}:bedrock:${this.region}:${this.account}:guardrail/${props.guardrailId}`;

    // Retrieve/AgenticRetrieveStream/ApplyGuardrail are CloudTrail *data*
    // events and are NOT logged by default — must opt in via an advanced
    // event selector naming the specific resource type and ARNs.
    const cfnTrail = trail.node.defaultChild as cloudtrail.CfnTrail;
    cfnTrail.advancedEventSelectors = [
      {
        name: 'BedrockKnowledgeBaseDataEvents',
        fieldSelectors: [
          { field: 'eventCategory', equalTo: ['Data'] },
          { field: 'resources.type', equalTo: ['AWS::Bedrock::KnowledgeBase'] },
          { field: 'resources.ARN', equalTo: [kbArn] },
        ],
      },
      {
        name: 'BedrockGuardrailDataEvents',
        fieldSelectors: [
          { field: 'eventCategory', equalTo: ['Data'] },
          { field: 'resources.type', equalTo: ['AWS::Bedrock::Guardrail'] },
          { field: 'resources.ARN', equalTo: [guardrailArn] },
        ],
      },
    ];

    const dashboard = new cloudwatch.Dashboard(this, 'MetrieverDashboard', {
      dashboardName: `Metriever-${props.envName}`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Agent Lambda (invocations / errors / duration)',
        left: [props.agentFunction.metricInvocations(), props.agentFunction.metricErrors()],
        right: [props.agentFunction.metricDuration()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Retrieval Lambda (invocations / errors / duration)',
        left: [props.retrievalFunction.metricInvocations(), props.retrievalFunction.metricErrors()],
        right: [props.retrievalFunction.metricDuration()],
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Ingestion State Machine (succeeded / failed)',
        left: [props.ingestionStateMachine.metricSucceeded(), props.ingestionStateMachine.metricFailed()],
        width: 12,
      }),
    );

    new cloudwatch.Alarm(this, 'AgentErrorAlarm', {
      metric: props.agentFunction.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
    });
    new cloudwatch.Alarm(this, 'RetrievalErrorAlarm', {
      metric: props.retrievalFunction.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
    });

    NagSuppressions.addResourceSuppressions(
      trail,
      [
        {
          id: 'AwsSolutions-CT1',
          reason: 'Management-event logging (ALL read/write) is already the Trail L2 construct default; this stack only adds data-event selectors on top.',
        },
        {
          id: 'AwsSolutions-S1',
          reason: "This is the Trail L2 construct's own auto-created log-delivery bucket; adding access logging to the audit-log bucket itself is not warranted at this project's scale.",
        },
      ],
      true,
    );
  }
}
