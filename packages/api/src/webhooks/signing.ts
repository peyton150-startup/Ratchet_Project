import { createHmac } from 'node:crypto';

// The verification half of this scheme lives in the SDK — the published artifact integrators use.
// Re-exported here so there is exactly one implementation and the two cannot drift.
//
// Imported from the "./signing" subpath, not the SDK root: the root entry is browser-safe for the
// consoles and deliberately omits signing, which needs node:crypto. Node resolves the subpath via
// the SDK's "exports" map; TypeScript's node10 resolution finds its types via "typesVersions".
export {
  verifyWebhookSignature as verifySignature,
  SIGNATURE_HEADER,
  type VerifyOptions,
} from '@workspace/sdk/signing';

/**
 * Sign a webhook body. Header format: "t=<unix seconds>,v1=<hex hmac-sha256>", where the signed
 * message is `${timestamp}.${body}` — so replaying an old body fails the receiver's freshness check.
 */
export function signBody(secret: string, body: string, timestampSec: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}
