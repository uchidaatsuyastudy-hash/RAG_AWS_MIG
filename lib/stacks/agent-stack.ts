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
  /** The KMS key the Guardrail is encrypted with (GuardrailStack's dataKey).
   * ApplyGuardrail needs kms:Decrypt on this key to read the guardrail config. */
  readonly guardrailKey: kms.IKey;
  /** Claude model ID or inference profile ID to invoke. Defaults to the `au.`
   * geographic inference profile — Claude Sonnet 4.6 does not support
   * on-demand (direct) invocation, so a profile is required; `au.` keeps
   * routing within the Australia geography (ap-southeast-2/ap-southeast-4)
   * rather than a `global.` profile that could route anywhere. */
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

    const modelId = props.modelId ?? 'au.anthropic.claude-sonnet-4-6';

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

    // Calling an inference profile requires permission on the profile ARN
    // *and* the underlying foundation-model ARN(s) it routes to. The `au.`
    // profile specifically routes within ap-southeast-2/ap-southeast-4 (per
    // `aws bedrock get-inference-profile`); a different profile would need
    // different underlying Regions here.
    const baseModelId = modelId.replace(/^(au|global)\./, '');
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeModelForAgentLoop',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${modelId}`,
          `arn:${this.partition}:bedrock:ap-southeast-2::foundation-model/${baseModelId}`,
          `arn:${this.partition}:bedrock:ap-southeast-4::foundation-model/${baseModelId}`,
        ],
      }),
    );
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ApplyGuardrail',
        actions: ['bedrock:ApplyGuardrail'],
        resources: [`arn:${this.partition}:bedrock:${this.region}:${this.account}:guardrail/${props.guardrailId}`],
      }),
    );
    props.guardrailKey.grantDecrypt(this.agentFunction);

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
        {
          id: 'AwsSolutions-IAM5',
          reason: "KMS Key.grantDecrypt() generates CDK's standard scoped grant limited to this specific key's ARN; required so ApplyGuardrail can read the guardrail configuration, which is encrypted with this key.",
        },
      ],
      true,
    );
  }
}
