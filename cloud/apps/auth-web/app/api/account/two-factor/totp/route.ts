// Authenticator app enrollment.
// POST  — start (or restart) enrollment: a fresh secret + QR code. Nothing is
//         enforced until /confirm sees a valid code. Needs the password when
//         the account has one (requireStrengtheningProof).
// DELETE — remove the authenticator (needs the weakening proof).
import QRCode from "qrcode";
import { NextRequest, NextResponse } from "next/server";
import {
  accountSecurityContext,
  notifySecurityChange,
  readJsonBody,
  requireStrengtheningProof,
  requireWeakeningProof,
} from "../../../../../src/lib/account-security";
import { recordAuditEvent } from "../../../../../src/lib/audit";
import { requireDatabase } from "../../../../../src/lib/device-flow";
import {
  beginTotpEnrollment,
  clearRecoveryCodesIfNoFactors,
  removeTotp,
  totpProvisioningUri,
} from "../../../../../src/lib/two-factor";

export async function POST(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-totp",
    mutating: true,
    recentAuth: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const denied = await requireStrengtheningProof(
    db,
    context,
    await readJsonBody(request),
  );
  if (denied) {
    return denied;
  }
  const secret = await beginTotpEnrollment(db, context.accountId);
  if (!secret) {
    return NextResponse.json({ error: "totp_already_enabled" }, { status: 409 });
  }
  const uri = totpProvisioningUri(secret, context.email);
  const qrSvg = await QRCode.toString(uri, {
    errorCorrectionLevel: "M",
    margin: 1,
    type: "svg",
  });
  return NextResponse.json({ otpauth_url: uri, qr_svg: qrSvg, secret });
}

export async function DELETE(request: NextRequest) {
  const { db, response } = requireDatabase();
  if (!db) {
    return response;
  }
  const context = await accountSecurityContext(request, db, {
    action: "two-factor-totp",
    mutating: true,
  });
  if ("response" in context) {
    return context.response;
  }
  const body = await readJsonBody(request);
  const denied = await requireWeakeningProof(db, context, body);
  if (denied) {
    return denied;
  }
  await removeTotp(db, context.accountId);
  const status = await clearRecoveryCodesIfNoFactors(db, context.accountId);
  await recordAuditEvent(db, {
    accountId: context.accountId,
    actor: {
      accountId: context.accountId,
      providerSubject: context.providerSubject,
    },
    eventType: status.enabled
      ? "account.totp_disabled"
      : "account.two_factor_disabled",
    metadata: { method: "totp" },
  });
  await notifySecurityChange(
    context,
    status.enabled ? "totp_disabled" : "two_factor_disabled",
  );
  return NextResponse.json({ ok: true, two_factor_enabled: status.enabled });
}
