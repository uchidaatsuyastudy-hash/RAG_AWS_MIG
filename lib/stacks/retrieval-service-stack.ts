import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';

export interface RetrievalServiceStackProps extends cdk.StackProps {
  /** Knowledge Base IDs this service searches across by default. */
  readonly knowledgeBaseIds: string[];
  readonly logsKey: kms.IKey;
}

/**
 * Lambda wrapper around Bedrock's AgenticRetrieveStream: a single call gets
 * query decomposition, managed reranking, and multi-Knowledge-Base search —
 * the managed-service replacement for the PDF resources' hand-rolled Query
 * Decomposition / Retrieval Grader / Ensemble Retriever (06 章).
 */
export class RetrievalServiceStack extends cdk.Stack {
  public readonly retrievalFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: RetrievalServiceStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'RetrievalServiceLogs', {
      encryptionKey: props.logsKey,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.retrievalFunction = new lambdaNodejs.NodejsFunction(this, 'RetrievalService', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'retrieval-service', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logGroup,
      environment: {
        KNOWLEDGE_BASE_IDS: props.knowledgeBaseIds.join(','),
        MAX_AGENT_ITERATION: '5',
      },
      bundling: { minify: true, sourceMap: true },
    });

    const kbArns = props.knowledgeBaseIds.map(
      (id) => `arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/${id}`,
    );

    this.retrievalFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AgenticRetrieveOnConfiguredKnowledgeBases',
        actions: ['bedrock:Retrieve', 'bedrock:AgenticRetrieveStream'],
        resources: kbArns,
      }),
    );
    this.retrievalFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ManagedPlannerEmbeddingRerankingModels',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        // AgenticRetrieveStream's MANAGED planner/embedding/reranking models
        // are AWS-selected, not user-specified ARNs — resource:* within the
        // foundation-model namespace (not a full "*") is the narrowest grant
        // the API's `MANAGED` mode allows for, scoped to this Region.
        resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/*`],
      }),
    );

    NagSuppressions.addResourceSuppressions(
      this.retrievalFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            "bedrock:InvokeModel* is scoped to the foundation-model/* namespace in this Region only, because AgenticRetrieveStream's MANAGED planner/embedding/reranking model selection is AWS-internal and does not expose specific model ARNs to the caller to scope to.",
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'NODEJS_22_X is the current non-deprecated LTS runtime at time of writing; kept here instead of a floating "latest" alias for reproducible builds.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole (CloudWatch Logs write access) is attached automatically by the Lambda L2 construct default execution role; not a hand-authored broad grant.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ],
      true,
    );
  }
}
