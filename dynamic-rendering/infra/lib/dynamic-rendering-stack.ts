#!/usr/bin/env node
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib"
import * as acm from "aws-cdk-lib/aws-certificatemanager"
import * as cloudfront from "aws-cdk-lib/aws-cloudfront"
import * as cloudfront_origins from "aws-cdk-lib/aws-cloudfront-origins"
import * as iam from "aws-cdk-lib/aws-iam"
import * as lambda from "aws-cdk-lib/aws-lambda"
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs"
import * as logs from "aws-cdk-lib/aws-logs"
import * as route53 from "aws-cdk-lib/aws-route53"
import * as targets from "aws-cdk-lib/aws-route53-targets"
import * as s3 from "aws-cdk-lib/aws-s3"
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment"
import { Construct } from "constructs"

export interface StaticSiteProps {
  domainName: string
  siteSubDomain: string
}

/**
 * Static site infrastructure, which deploys site content to an S3 bucket.
 *
 * The site redirects from HTTP to HTTPS, using a CloudFront distribution,
 * Route53 alias record, and ACM certificate.
 */
export class StaticSite extends Construct {
  constructor(parent: Stack, name: string, props: StaticSiteProps) {
    super(parent, name)

    const zone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: props.domainName,
    })
    const siteDomain = props.siteSubDomain + "." + props.domainName
    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(
      this,
      "cloudfront-OAI",
      {
        comment: `OAI for ${name}`,
      }
    )

    new CfnOutput(this, "Site", { value: "https://" + siteDomain })

    // Content bucket
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      bucketName: siteDomain,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

      /**
       * The default removal policy is RETAIN, which means that cdk destroy will not attempt to delete
       * the new bucket, and it will remain in your account until manually deleted. By setting the policy to
       * DESTROY, cdk destroy will attempt to delete the bucket, but will error if the bucket is not empty.
       */
      removalPolicy: RemovalPolicy.DESTROY, // NOT recommended for production code

      /**
       * For sample purposes only, if you create an S3 bucket then populate it, stack destruction fails.  This
       * setting will enable full cleanup of the demo.
       */
      autoDeleteObjects: true, // NOT recommended for production code
    })

    // Grant access to cloudfront
    siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [siteBucket.arnForObjects("*")],
        principals: [
          new iam.CanonicalUserPrincipal(
            cloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    )
    new CfnOutput(this, "Bucket", { value: siteBucket.bucketName })

    // TLS certificate
    // const certificate = new acm.Certificate(this, "SiteCertificate", {
    //   domainName: siteDomain,
    //   validation: acm.CertificateValidation.fromDns(zone),
    // });
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "SiteCertificate",
      "arn:aws:acm:us-east-1:877131159332:certificate/ba35c31d-d07d-411f-b297-2ba3901208c8"
    )

    // new CfnOutput(this, "Certificate", { value: certificate.certificateArn })

    // DynamicRender Lambda
    const viewerRequestLambda = new NodejsFunction(this, "ViewerRequest", {
      entry: "../lambda/viewer-request/index.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_18_X,
      logRetention: logs.RetentionDays.ONE_WEEK,
    })
    const originRequestLambda = new NodejsFunction(this, "OriginRequest", {
      entry: "../lambda/origin-request/index.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_18_X,
      memorySize: 4096,
      timeout: Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_WEEK,
    })

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      certificate: certificate,
      defaultRootObject: "index.html",
      domainNames: [siteDomain],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: new cloudfront_origins.S3Origin(siteBucket, {
          originAccessIdentity: cloudfrontOAI,
        }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: new cloudfront.CachePolicy(this, "CachePolicy", {
          enableAcceptEncodingBrotli: true,
          enableAcceptEncodingGzip: true,
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
            // Lambda@Edge Origin Requestはキャッシュにヒットしなかったときのみ呼ばれる。そのため、x-need-dynamic-renderの有無によってキャッシュを分離する必要がある
            "x-need-dynamic-render"
          ),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        edgeLambdas: [
          {
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
            functionVersion: viewerRequestLambda.currentVersion,
          },
          {
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: originRequestLambda.currentVersion,
          },
        ],
      },
    })

    new CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    })
    new CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
    })

    // Comment out because we use CloudFlare
    //
    // Route53 alias record for the CloudFront distribution
    // new route53.ARecord(this, "SiteAliasRecord", {
    //   recordName: siteDomain,
    //   target: route53.RecordTarget.fromAlias(
    //     new targets.CloudFrontTarget(distribution)
    //   ),
    //   zone,
    // })

    // Deploy site contents to S3 bucket
    new s3deploy.BucketDeployment(this, "DeployWithInvalidation", {
      sources: [s3deploy.Source.asset("../front-app/dist")],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    })
  }
}
