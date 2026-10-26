import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  readonly rawDocsBucket: s3.IBucket;
  readonly dataKey: kms.IKey;
}

/**
 * Bedrock Managed Knowledge Base (MKB): AWS manages chunking, embedding and
 * the vector store, so this stack only needs a connector-scoped IAM role,
 * the KnowledgeBase resource, and an S3 managed-connector DataSource.
 * See references/managed-knowledge-bases-setup.md in the amazon-bedrock
 * skill — this is NOT the Customer-managed `s3Configuration` shape.
 */
export class KnowledgeBaseStack extends cdk.Stack {
  public readonly knowledgeBaseId: string;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);
    this.terminationProtection = true;

    const role = new iam.Role(this, 'KnowledgeBaseRole', {
      roleName: 'AmazonBedrockExecutionRoleForKB-metriever',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    });
    props.rawDocsBucket.grantRead(role);
    props.dataKey.grantDecrypt(role);
    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            "Bucket.grantRead() generates CDK's standard scoped read-action wildcards (GetObject*, GetBucket*, List*) limited to this specific bucket's ARN and ARN/*; this is the AWS-recommended grant pattern for connector read access, not a hand-authored broad permission.",
        },
      ],
      true,
    );

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: 'metriever-kb',
      roleArn: role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'MANAGED',
        managedKnowledgeBaseConfiguration: {
          embeddingModelType: 'MANAGED',
        },
      },
    });

    const dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      name: 'metriever-raw-docs',
      dataSourceConfiguration: {
        type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: {
          connectorParameters: {
            type: 'S3',
            version: '1',
            connectionConfiguration: {
              bucketName: props.rawDocsBucket.bucketName,
              bucketOwnerAccountId: this.account,
            },
          },
        },
      },
    });

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.dataSourceId = dataSource.attrDataSourceId;

    new cdk.CfnOutput(this, 'KnowledgeBaseIdOutput', { value: knowledgeBase.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'DataSourceIdOutput', { value: dataSource.attrDataSourceId });
  }
}
