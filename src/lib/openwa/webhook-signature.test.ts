import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyOpenWAWebhookSignature } from "./webhook-signature";

const SECRET = process.env.OPENWA_WEBHOOK_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("verifyOpenWAWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({
      event: "message.received",
      sessionId: "wacrm-acct",
    });
    expect(verifyOpenWAWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(
      verifyOpenWAWebhookSignature(body, signedHeader(body, "wrong")),
    ).toBe(false);
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"event":"session.qr"}';
    const header = signedHeader(original);
    const tampered = '{"event":"session.authenticated"}';
    expect(verifyOpenWAWebhookSignature(tampered, header)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyOpenWAWebhookSignature("anything", null)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const hex = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyOpenWAWebhookSignature(body, hex)).toBe(false);
    expect(verifyOpenWAWebhookSignature(body, `sha512=${hex}`)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    // timingSafeEqual throws on length mismatch — the guard inside the
    // verifier must catch this and return false instead.
    expect(verifyOpenWAWebhookSignature("{}", "sha256=tooshort")).toBe(false);
  });
});
