import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FoundationStack } from '../lib/stacks/foundation-stack';

describe('cdk-nag AwsSolutionsChecks', () => {
  test('FoundationStack has no unsuppressed errors', () => {
    const app = new cdk.App();
    const stack = new FoundationStack(app, 'TestFoundation', {
      env: { account: '123456789012', region: 'ap-southeast-2' },
      envName: 'test',
      budgetAlertEmail: 'test@example.com',
    });
    Aspects.of(stack).add(new AwsSolutionsChecks());

    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toHaveLength(0);
  });
});
