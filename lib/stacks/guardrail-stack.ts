import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface GuardrailStackProps extends cdk.StackProps {
  readonly dataKey: kms.IKey;
}

const HARMFUL_CONTENT_TYPES = ['HATE', 'INSULTS', 'SEXUAL', 'VIOLENCE', 'MISCONDUCT'];

/**
 * Content-safety guardrail applied to the agent's generated answers (see
 * agent-stack.ts). Equivalent in intent to the content_filter_results the
 * PDF resources only logged but never acted on (02 章) — here it actually
 * blocks/masks before the response reaches the caller.
 */
export class GuardrailStack extends cdk.Stack {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props: GuardrailStackProps) {
    super(scope, id, props);

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: 'metriever-guardrail',
      description: 'Content safety and PII handling for the Metriever RAG agent.',
      blockedInputMessaging: 'This request cannot be processed because it violates content guidelines.',
      blockedOutputsMessaging: 'The generated response was withheld because it violated content guidelines.',
      kmsKeyArn: props.dataKey.keyArn,
      contentPolicyConfig: {
        filtersConfig: [
          ...HARMFUL_CONTENT_TYPES.map((type) => ({
            type,
            inputStrength: 'HIGH',
            outputStrength: 'HIGH',
          })),
          // Prompt injection / jailbreak attempts against the agent itself.
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: ['EMAIL', 'PHONE', 'NAME', 'ADDRESS', 'US_SOCIAL_SECURITY_NUMBER', 'CREDIT_DEBIT_CARD_NUMBER'].map(
          (type) => ({ type, action: 'ANONYMIZE' }),
        ),
      },
    });

    const version = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Initial published version.',
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailVersion = version.attrVersion;

    new cdk.CfnOutput(this, 'GuardrailIdOutput', { value: this.guardrailId });
    new cdk.CfnOutput(this, 'GuardrailVersionOutput', { value: this.guardrailVersion });
  }
}
