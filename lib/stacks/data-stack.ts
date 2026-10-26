import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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
  /** Change-notification queue; created here (not in IngestionPipelineStack)
   * because an S3->SQS notification across stacks creates a cyclic
   * cross-stack dependency when the two resources live in different stacks. */
  public readonly changeQueue: sqs.Queue;

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

    // SQS_MANAGED encryption deliberately (not the shared CMK): this queue
    // only carries S3 event metadata (bucket/key names), not document
    // content, and encrypting it with the CMK would require a cross-stack
    // KMS grant back to whichever stack consumes it.
    const changeQueueDlq = new sqs.Queue(this, 'RawDocsChangeDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.changeQueue = new sqs.Queue(this, 'RawDocsChangeQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: changeQueueDlq, maxReceiveCount: 3 },
    });
    this.rawDocsBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(this.changeQueue));
    this.rawDocsBucket.addEventNotification(s3.EventType.OBJECT_REMOVED, new s3n.SqsDestination(this.changeQueue));

    NagSuppressions.addResourceSuppressions(
      changeQueueDlq,
      [{ id: 'AwsSolutions-SQS3', reason: 'This queue is itself the dead-letter queue for RawDocsChangeQueue.' }],
    );
    NagSuppressions.addResourceSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            "AWSLambdaBasicExecutionRole is attached by CDK's own internal BucketNotificationsHandler custom resource (created by Bucket.addEventNotification); not a hand-authored role in this app.",
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ],
      true,
    );
  }
}
