#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PipelineStack } from '../lib/pipeline-stack';

// This AWS project is pinned to a single account/Region by the organization's
// "new AWS experience" constraints — no cross-Region resources are permitted.
// The account ID is intentionally NOT hardcoded here (this repo is public):
// the CDK CLI populates CDK_DEFAULT_ACCOUNT from the caller's resolved AWS
// credentials, and CI resolves it from the CodeBuild execution role.
if (!process.env.CDK_DEFAULT_ACCOUNT) {
  throw new Error(
    'CDK_DEFAULT_ACCOUNT is not set. Run via `cdk` with valid AWS credentials, ' +
      'or set it explicitly (e.g. `$env:CDK_DEFAULT_ACCOUNT=\'<account-id>\'`).',
  );
}
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-southeast-2',
};

const app = new cdk.App();

Tags.of(app).add('Project', 'Metriever');
Tags.of(app).add('ManagedBy', 'CDK');

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// CodeConnections ARNs embed the account ID; build it from `env.account`
// (never hardcoded) rather than pasting the full ARN into source control.
const connectionId = '3b7d81d0-55f6-43de-8524-ae37139a0727';
const connectionArn = `arn:aws:codeconnections:${env.region}:${env.account}:connection/${connectionId}`;

new PipelineStack(app, 'Metriever-Pipeline', {
  env,
  connectionArn,
  devBudgetAlertEmail: app.node.tryGetContext('devBudgetAlertEmail'),
  prodBudgetAlertEmail: app.node.tryGetContext('prodBudgetAlertEmail'),
});
