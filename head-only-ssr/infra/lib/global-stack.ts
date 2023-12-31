import {
  CfnOutput,
  Duration,
  Stack,
  StackProps,
  aws_certificatemanager,
  aws_cloudfront,
  aws_cloudfront_origins,
  aws_lambda,
  aws_lambda_nodejs,
  aws_logs,
  aws_route53,
  aws_s3,
} from "aws-cdk-lib"
import { Construct } from "constructs"
import { readFileSync } from "fs"

type GlobalStackProps = {
  /** example.com */
  domainName: string
  /** foo.example.com */
  siteDomain: string
  siteBucket: aws_s3.Bucket
  cloudfrontOAI: aws_cloudfront.OriginAccessIdentity
} & StackProps

export class GlobalStack extends Stack {
  zone: aws_route53.IHostedZone
  certificate: aws_certificatemanager.ICertificate
  originResponseFunction: aws_lambda_nodejs.NodejsFunction

  constructor(parent: Construct, name: string, props: GlobalStackProps) {
    super(parent, name, props)

    // TLS certificate
    // this.certificate = new aws_certificatemanager.Certificate(this, "SiteCertificate", {
    //   domainName: props.siteDomain,
    //   validation: aws_certificatemanager.CertificateValidation.fromDns(this.zone),
    // })

    const certificate = aws_certificatemanager.Certificate.fromCertificateArn(
      this,
      "SiteCertificate",
      "arn:aws:acm:us-east-1:877131159332:certificate/ba35c31d-d07d-411f-b297-2ba3901208c8",
    )

    // new CfnOutput(this, "Certificate", { value: this.certificate.certificateArn })

    // Lambda@Edge
    const originRequestFunction = new aws_lambda_nodejs.NodejsFunction(
      this,
      "OriginRequestFunction",
      {
        entry: "../lambda/origin-request/index.ts",
        handler: "handler",
        runtime: aws_lambda.Runtime.NODEJS_18_X,
        logRetention: aws_logs.RetentionDays.ONE_WEEK,
        bundling: {
          define: {
            __SITE_ROOT_INDEX_HTML_CONTENT: JSON.stringify(
              readFileSync("../front-app/dist/index.html", "utf-8"),
            ),
          },
        },
      },
    )

    // CloudFront distribution
    const distribution = new aws_cloudfront.Distribution(this, "SiteDistribution", {
      certificate: certificate,
      defaultRootObject: "index.html",
      domainNames: [props.siteDomain],
      minimumProtocolVersion: aws_cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: "/error.html",
          ttl: Duration.minutes(30),
        },
      ],
      defaultBehavior: {
        origin: new aws_cloudfront_origins.S3Origin(props.siteBucket, {
          originAccessIdentity: props.cloudfrontOAI,
        }),
        compress: true,
        allowedMethods: aws_cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        edgeLambdas: [
          {
            eventType: aws_cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: originRequestFunction.currentVersion,
          },
        ],
      },
    })

    new CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    })
    // NOTE: Register this domain as CNAME in Cloudflare console
    new CfnOutput(this, "CloudFrontDomain", {
      value: distribution.distributionDomainName,
    })
  }
}
