import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import { Repository } from './resources/repository'
import { Vpc } from './vpc'

const memory = {
  dev: 3008,
  test: 5102,
  production: 10240,
}

const accountId = 'string' // Consider solving this dynamically as per your TODO

interface Props {
  vpc: Vpc
  hostedZone: pulumi.Input<string>
  repository: Repository
  encryptionKey: aws.kms.Key
  ocrStreamArn: pulumi.Output<string>
}

export class DecodingMlCrawlingLambdas extends pulumi.ComponentResource {
  private readonly tags = {
    module: 'ai',
    scope: DecodingMlCrawlingLambdas.name.toLowerCase(),
  }

  constructor(
    name: string,
    props: Props,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super(
      `decodingml:ai:${DecodingMlCrawlingLambdas.name.toLowerCase()}`,
      name,
      {},
      opts,
    )

    props.ocrStreamArn.apply(streamArn => {
      const lambdaRole = new aws.iam.Role(
        'lambda-crawling-processing-execution-role',
        {
          assumeRolePolicy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Action: 'sts:AssumeRole',
                Principal: { Service: 'lambda.amazonaws.com' },
                Effect: 'Allow',
                Sid: '',
              },
            ],
          }),
          inlinePolicies: [
            {
              name: 'DynamoDBStreamRead',
              policy: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'dynamodb:GetRecords',
                      'dynamodb:GetShardIterator',
                      'dynamodb:DescribeStream',
                      'dynamodb:ListStreams',
                    ],
                    Resource: streamArn,
                  },
                ],
              }),
            },
            {
              name: 'LambdaCloudWatchLogs',
              policy: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'logs:CreateLogGroup',
                      'logs:CreateLogStream',
                      'logs:PutLogEvents',
                    ],
                    Resource: `arn:aws:logs:${process.env.AWS_REGION}:${accountId}:log-group:/aws/lambda/*:*`,
                  },
                ],
              }),
            },
            {
              name: 'KMSDecryptPermission',
              policy: pulumi
                .all([props.encryptionKey.arn])
                .apply(([encryptionKeyArn]) =>
                  JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [
                      {
                        Effect: 'Allow',
                        Action: 'kms:Decrypt',
                        Resource: encryptionKeyArn,
                      },
                    ],
                  }),
                ),
            },
            {
              name: 'DynamoDBWriteAccess',
              policy: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'dynamodb:PutItem',
                      'dynamodb:UpdateItem',
                      'dynamodb:DeleteItem',
                    ],
                    Resource: '*',
                  },
                ],
              }),
            },
          ],
          tags: this.tags,
        },
        { parent: this },
      )

      // Original Lambda 
      const githubCrawler=this.createLambdaFunction(
        'github-crawler-latest',
        lambdaRole.arn,
        streamArn,
      )

      const linkedinCrawler=this.createLambdaFunction(
        'linkedin-crawler-latest',
        lambdaRole.arn,
        streamArn,
      )

      const mediumCrawler=this.createLambdaFunction(
        'medium-crawler-latest',
        lambdaRole.arn,
        streamArn,
      )
      this.scheduleLambdaFunction(githubCrawler, 'rate(1 day)');
      this.scheduleLambdaFunction(linkedinCrawler, 'rate(1 day)');
      this.scheduleLambdaFunction(mediumCrawler, 'rate(1 day)');
    
    })
  }


  private scheduleLambdaFunction(lambdaFunction: aws.lambda.Function, scheduleExpression: string): void {
    const rule = new aws.cloudwatch.EventRule(`${lambdaFunction.name}-schedule`, {
      scheduleExpression: scheduleExpression,
    }, { parent: this });

    new aws.cloudwatch.EventTarget(`${lambdaFunction.name}-target`, {
      rule: rule.name,
      arn: lambdaFunction.arn,
    }, { parent: rule });

    new aws.lambda.Permission(`${lambdaFunction.name}-invoke-permission`, {
      action: 'lambda:InvokeFunction',
      function: lambdaFunction.name,
      principal: 'events.amazonaws.com',
      sourceArn: rule.arn,
    }, { parent: lambdaFunction });
  }


  private createLambdaFunction(
    name: string,
    roleArn: pulumi.Output<string>,
    streamArn: string,
  ): aws.lambda.Function {
    const lambdaFunction = new aws.lambda.Function(
      name,
      {
        packageType: 'Image',
        tags: this.tags,
        imageUri: `904977793552.dkr.ecr.eu-central-1.amazonaws.com/ai:${name}`,
        architectures: ['arm64'],
        memorySize: memory.dev,
        timeout: 900,
        role: roleArn,
        environment: {
          variables: { DYNAMO_TABLE: 'crawler-results' },
        },
      },
      { parent: this },
    )

    new aws.lambda.EventSourceMapping(
      `${name}-dynamodb-stream-mapping`,
      {
        eventSourceArn: streamArn,
        functionName: lambdaFunction.arn,
        startingPosition: 'LATEST',
      },
      { parent: lambdaFunction },
    );
    return lambdaFunction;
  }
}
