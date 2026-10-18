import { describe, expect, it, vi } from "vitest";
import { logInboundSkip, maskNumber, maskSessionNumber } from "./inbound-log.js";

describe("inbound skip log", () => {
  it("masks every number form to the country prefix and the last four digits", () => {
    expect(maskNumber("+39 333 1234567")).toBe("+39…4567");
    expect(maskNumber("whatsapp:+393331234567")).toBe("+39…4567");
    expect(maskNumber("393331234567@s.whatsapp.net")).toBe("+39…4567");
    expect(maskNumber(undefined, "group-id", "393331234567")).toBe("+39…4567");
    expect(maskNumber("not a number")).toBe("unknown");
    expect(maskSessionNumber("agent:main:kapso-whatsapp:direct:393331234567")).toBe("+39…4567");
    expect(maskSessionNumber(undefined)).toBe("unknown");
  });

  it("writes one info line with the stage, the reason and a masked sender, and no message text", () => {
    const info = vi.fn();
    logInboundSkip(
      { info },
      {
        stage: "reaction",
        reason: "not_a_whatsapp_message_id",
        sender: ["", "+393331234567"],
        messageId: "wamid.HBgMMzkwMDAwMDAwMDAwFQIAEhgUM0I",
      },
    );
    expect(info).toHaveBeenCalledWith(
      "ada inbound skipped stage=reaction reason=not_a_whatsapp_message_id sender=+39…4567 msg=…hgUM0I",
    );
  });

  it("does not need an info logger", () => {
    expect(() => logInboundSkip({}, { stage: "x", reason: "y" })).not.toThrow();
  });
});
