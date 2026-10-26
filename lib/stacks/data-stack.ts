import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { NagSuppressions } from 'cdk-nag';

export interface DataStackProps extends cdk.StackProps {
  /** CMK (from FoundationStack) used to encrypt the raw document bucket. */
  readonly dataKey: kms.IKey;
}

/**
 * Stateful data layer: the S3 bucket that holds source documents for the
 * Knowledge Base. Kept in its own stack with termination protection since
 * it is rarely changed and holds data, unlike the frequently-iterated
 * ingestion/retrieval logic stacks.
 */
export class DataStack extends cdk.Stack {
  public readonly rawDocsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    this.terminationProtection = true;

    // S3 server access logs must land in a separate bucket using the
    // S3 log-delivery SSE-S3 default; SSE-KMS targets are not supported.
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });
    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
      { id: 'AwsSolutions-S1', reason: 'This bucket is itself the server access log destination; logging its own access would be circular.' },
    ]);

    this.rawDocsBucket = new s3.Bucket(this, 'RawDocsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.dataKey,
      bucketKeyEnabled: true,
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'raw-docs-access-logs/',
    });
  }
}
