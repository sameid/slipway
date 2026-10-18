// Parameter Store and Secrets Manager. The deployer can write app secret values
// but never read them (design 5.8): there is deliberately no getter for /apps/*.
// Also ACM, for custom domains' certificates.
import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
} from "@aws-sdk/client-acm";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

export type CertificateState = {
  /** ACM's: PENDING_VALIDATION, ISSUED, FAILED, VALIDATION_TIMED_OUT, REVOKED, EXPIRED, INACTIVE. */
  status: string;
  /** The CNAME that proves control of the name, once ACM has made it (a few seconds after the request). */
  record?: { name: string; value: string };
  failureReason?: string;
  /** Whether something (CloudFront) uses it; ACM won't delete it until nothing does. */
  inUse: boolean;
};

export interface Platform {
  /** Write /apps/<app>/<env>/<KEY> as a SecureString. */
  putAppSecret(name: string, value: string): Promise<void>;
  /**
   * A deploy failed: count it in the slipway/FailedDeploys metric (the
   * foundation alarms on it) and, for prod, tell the dev team's SNS topic.
   */
  deployFailed(failure: { app: string; env: "staging" | "prod"; summary: string; link: string }): Promise<void>;
  /** A DNS-validated certificate for a custom domain, in us-east-1 (CloudFront only uses those). Returns its ARN. */
  requestCertificate(req: { hostname: string; idempotencyToken: string; tags: Record<string, string> }): Promise<string>;
  describeCertificate(arn: string): Promise<CertificateState>;
  deleteCertificate(arn: string): Promise<"deleted" | "in_use" | "not_found">;
}

/** Terraform creates SSM parameters with this value until someone sets them. */
export const PLACEHOLDER = "unset";

export class AwsPlatform implements Platform {
  private ssm: SSMClient;
  private cloudwatch: CloudWatchClient;
  private sns: SNSClient;
  private acm: ACMClient;

  constructor(
    private opts: { region: string; kmsKeyId?: string; alertsTopicArn?: string },
  ) {
    this.ssm = new SSMClient({ region: opts.region });
    this.cloudwatch = new CloudWatchClient({ region: opts.region });
    this.sns = new SNSClient({ region: opts.region });
    // CloudFront only uses certificates from us-east-1, wherever the app runs.
    this.acm = new ACMClient({ region: "us-east-1" });
  }

  async requestCertificate(req: { hostname: string; idempotencyToken: string; tags: Record<string, string> }): Promise<string> {
    const out = await this.acm.send(
      new RequestCertificateCommand({
        DomainName: req.hostname,
        ValidationMethod: "DNS",
        IdempotencyToken: req.idempotencyToken,
        Tags: Object.entries(req.tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
    if (!out.CertificateArn) throw new Error("ACM returned no certificate ARN");
    return out.CertificateArn;
  }

  async describeCertificate(arn: string): Promise<CertificateState> {
    const { Certificate: c } = await this.acm.send(new DescribeCertificateCommand({ CertificateArn: arn }));
    const record = c?.DomainValidationOptions?.[0]?.ResourceRecord;
    return {
      status: c?.Status ?? "UNKNOWN",
      record: record?.Name && record.Value ? { name: record.Name, value: record.Value } : undefined,
      failureReason: c?.FailureReason,
      inUse: (c?.InUseBy?.length ?? 0) > 0,
    };
  }

  async deleteCertificate(arn: string): Promise<"deleted" | "in_use" | "not_found"> {
    try {
      await this.acm.send(new DeleteCertificateCommand({ CertificateArn: arn }));
      return "deleted";
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "ResourceInUseException") return "in_use";
      if (name === "ResourceNotFoundException") return "not_found";
      throw err;
    }
  }

  async deployFailed(f: { app: string; env: "staging" | "prod"; summary: string; link: string }): Promise<void> {
    await this.cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "slipway",
        MetricData: [{ MetricName: "FailedDeploys", Dimensions: [{ Name: "Env", Value: f.env }], Value: 1, Unit: "Count" }],
      }),
    );
    if (f.env === "prod" && this.opts.alertsTopicArn) {
      await this.sns.send(
        new PublishCommand({
          TopicArn: this.opts.alertsTopicArn,
          Subject: `slipway: prod deploy of ${f.app} failed`.slice(0, 100),
          Message: `${f.summary}\n\n${f.link}`,
        }),
      );
    }
  }

  async putAppSecret(name: string, value: string): Promise<void> {
    await this.ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: "SecureString",
        // Without a KeyId, SSM encrypts with its AWS-managed key (aws/ssm).
        ...(this.opts.kmsKeyId ? { KeyId: this.opts.kmsKeyId } : {}),
        Overwrite: true,
        Tier: "Standard",
      }),
    );
  }
}

export async function getSecretJson<T>(client: SecretsManagerClient, id: string): Promise<T> {
  const res = await client.send(new GetSecretValueCommand({ SecretId: id }));
  if (!res.SecretString) throw new Error(`Secret ${id} has no value yet`);
  return JSON.parse(res.SecretString) as T;
}

export async function loadGithubAppSecret(
  region: string,
  id: string,
): Promise<{ appId: string; privateKey: string; webhookSecret: string }> {
  const value = await getSecretJson<{ appId: string | number; privateKey: string; webhookSecret: string }>(
    new SecretsManagerClient({ region }),
    id,
  );
  if (!value.appId || !value.privateKey || !value.webhookSecret) {
    throw new Error(`${id} must hold {"appId","privateKey","webhookSecret"}`);
  }
  return { appId: String(value.appId), privateKey: normalizePem(value.privateKey), webhookSecret: value.webhookSecret };
}

/**
 * Rebuilds a PEM key whose line breaks were lost or escaped on the way into
 * Secrets Manager (the console's key/value editor turns them into spaces;
 * hand-written JSON often has a literal "\n").
 */
export function normalizePem(pem: string): string {
  const text = pem.replace(/\\n/g, "\n").trim();
  const match = /^-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----$/.exec(text);
  if (!match) return text;
  const [, label, body] = match;
  const base64 = (body ?? "").replace(/\s+/g, "");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ""].join("\n");
}

export async function loadParameter(region: string, name: string): Promise<string> {
  const res = await new SSMClient({ region }).send(new GetParameterCommand({ Name: name }));
  const value = res.Parameter?.Value;
  if (!value || value === PLACEHOLDER) throw new Error(`SSM parameter ${name} isn't set yet`);
  return value;
}
