import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';

export interface AgentStackProps extends cdk.StackProps {
  readonly retrievalFunction: lambda.IFunction;
  readonly guardrailId: string;
  readonly guardrailVersion: string;
  readonly logsKey: kms.IKey;
  /** On-demand Claude model ID available in this Region (no cross-Region inference profile — see FoundationStack note on Region pinning). */
  readonly modelId?: string;
}

/**
 * RAG / general-knowledge routing agent (see lambda/agent/index.ts for why
 * this is a Converse-tool-use Lambda rather than an AgentCore Harness).
 */
export class AgentStack extends cdk.Stack {
  public readonly agentFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const modelId = props.modelId ?? 'anthropic.claude-sonnet-4-6';

    const logGroup = new logs.LogGroup(this, 'AgentLogs', {
      encryptionKey: props.logsKey,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.agentFunction = new lambdaNodejs.NodejsFunction(this, 'Agent', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'agent', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(90),
      memorySize: 512,
      logGroup,
      environment: {
        MODEL_ID: modelId,
        RETRIEVAL_FUNCTION_NAME: props.retrievalFunction.functionName,
        GUARDRAIL_ID: props.guardrailId,
        GUARDRAIL_VERSION: props.guardrailVersion,
        MAX_TOKENS: '1024',
        MAX_TOOL_ITERATIONS: '4',
      },
      bundling: { minify: true, sourceMap: true },
    });

    props.retrievalFunction.grantInvoke(this.agentFunction);

    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeModelForAgentLoop',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${modelId}`],
      }),
    );
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ApplyGuardrail',
        actions: ['bedrock:ApplyGuardrail'],
        resources: [`arn:${this.partition}:bedrock:${this.region}:${this.account}:guardrail/${props.guardrailId}`],
      }),
    );

    NagSuppressions.addResourceSuppressions(
      this.agentFunction,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is attached automatically by the Lambda L2 construct default execution role.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'NODEJS_22_X is the current non-deprecated LTS runtime at time of writing.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: "Function.grantInvoke()'s trailing ':*' is CDK's standard pattern to allow invoking any version/alias of this specific function; the resource is still scoped to one function ARN, not a wildcard across functions.",
          appliesTo: ['Resource::<RetrievalService82B07310.Arn>:*'],
        },
      ],
      true,
    );
  }
}
