import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { ApplicationStage } from './stages/application-stage';

const REPO = 'uchidaatsuyastudy-hash/RAG_AWS_MIG';
const BRANCH = 'main';

export interface PipelineStackProps extends cdk.StackProps {
  readonly connectionArn: string;
  readonly devBudgetAlertEmail?: string;
  readonly prodBudgetAlertEmail?: string;
}

/**
 * Self-mutating CDK Pipeline: GitHub (via CodeConnections) -> build/test/synth
 * -> Dev -> manual approval -> Prod. All stacks deploy to the single
 * account/Region this AWS project is pinned to; Dev/Prod are separated by
 * Stage (stack name prefix), not by account or Region.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const source = pipelines.CodePipelineSource.connection(REPO, BRANCH, {
      connectionArn: props.connectionArn,
    });

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'Metriever-Pipeline',
      selfMutation: true,
      crossAccountKeys: false,
      synth: new pipelines.ShellStep('Synth', {
        input: source,
        commands: ['npm ci', 'npm run build', 'npm test', 'npx cdk synth'],
      }),
      codeBuildDefaults: {
        rolePolicy: [
          new iam.PolicyStatement({
            sid: 'ScopedCodeConnectionsAccess',
            actions: ['codeconnections:UseConnection'],
            resources: [props.connectionArn],
            conditions: {
              StringEquals: { 'codeconnections:FullRepositoryId': REPO },
            },
          }),
        ],
      },
    });

    const devStage = pipeline.addStage(
      new ApplicationStage(this, 'Dev', {
        env: { account: this.account, region: this.region },
        budgetAlertEmail: props.devBudgetAlertEmail,
        monthlyBudgetLimitUsd: 20,
      }),
    );
    devStage.addPost(
      new pipelines.ShellStep('SmokeTest', {
        commands: ['echo "TODO: replace with a real Dev smoke test once Phase 2 ships a Knowledge Base"'],
      }),
    );

    pipeline.addStage(
      new ApplicationStage(this, 'Prod', {
        env: { account: this.account, region: this.region },
        budgetAlertEmail: props.prodBudgetAlertEmail,
        monthlyBudgetLimitUsd: 80,
      }),
      {
        pre: [new pipelines.ManualApprovalStep('PromoteToProd')],
      },
    );

    // CDK Pipelines builds its internal CodePipeline/CodeBuild/S3 resources
    // lazily; force that now so suppressions below actually attach to them.
    pipeline.buildPipeline();

    NagSuppressions.addResourceSuppressions(
      pipeline,
      [
        {
          id: 'AwsSolutions-S1',
          reason:
            'Pipeline artifact bucket is provisioned internally by the aws-cdk-lib/pipelines CodePipeline L3 construct; access logging is not exposed as a construct prop. Contents are build artifacts, not user data.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcard actions/resources (scoped S3 object paths, CloudWatch Logs/CodeBuild report-group suffix wildcards, cross-stack iam:PassRole for CDK deployment roles) are generated internally by the aws-cdk-lib/pipelines CodePipeline and CodeBuild L2/L3 constructs following AWS-published reference patterns; not hand-authored by this app.',
        },
        {
          id: 'AwsSolutions-CB4',
          reason:
            'CodeBuild projects created internally by aws-cdk-lib/pipelines use the default AWS-managed S3 encryption; a customer-managed KMS key is not exposed as a construct prop on this L3 construct.',
        },
      ],
      true,
    );
  }
}
