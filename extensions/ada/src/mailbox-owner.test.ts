import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accounts = vi.hoisted(() => ({ byOwner: new Map<string, { email: string }>() }));
const clearAccount = vi.hoisted(() => vi.fn(async (_owner: string) => {}));
const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn());

vi.mock("./google-account.js", () => ({
  openAdaGoogleAccountDbFromApi: async () => ({
    listOwners: async () => [...accounts.byOwner.keys()],
    readAccount: async (owner: string) => accounts.byOwner.get(owner) ?? null,
    clearAccount: async (owner: string) => {
      await clearAccount(owner);
      accounts.byOwner.delete(owner);
    },
  }),
}));
vi.mock("./memory.js", () => ({ openAdaMemoryIfExistsFromApi }));

import { takeConnectOffers } from "./connect-offers.js";
import { releaseMailboxFromOtherOwners } from "./mailbox-owner.js";

const ANNA = "393331111111";
const BRUNO = "393332222222";
const CARLA = "393333333333";

function setup() {
  const sent: Array<{ to: string; text: string }> = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    config: {},
    logger,
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (params: { to: string; text: string }) => {
              sent.push({ to: params.to, text: params.text });
            },
          }),
        },
      },
    },
  } as unknown as Pick<OpenClawPluginApi, "runtime" | "runtimeSource" | "config" | "logger">;
  return { api, sent, logger };
}

beforeEach(() => {
  vi.clearAllMocks();
  accounts.byOwner.clear();
  openAdaMemoryIfExistsFromApi.mockResolvedValue(null);
});

describe("a mailbox has exactly one owner", () => {
  it("takes the mailbox from the number that had it, tells that number, and leaves the others alone", async () => {
    accounts.byOwner.set(ANNA, { email: "Shared@Example.com" });
    accounts.byOwner.set(BRUNO, { email: "shared@example.com" });
    accounts.byOwner.set(CARLA, { email: "carla@example.com" });
    const { api, sent, logger } = setup();

    await releaseMailboxFromOtherOwners(api, BRUNO, "shared@example.com");

    expect(clearAccount.mock.calls.map(([owner]) => owner)).toEqual([ANNA]);
    expect([...accounts.byOwner.keys()].toSorted()).toEqual([BRUNO, CARLA]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`+${ANNA}`);
    expect(sent[0]?.text).toContain("collegata da un altro numero");
    expect(sent[0]?.text).toContain("Vuoi che ti mandi il link per ricollegarla?");
    expect(sent[0]?.text).not.toMatch(/«|scrivimi/u);
    expect(takeConnectOffers(ANNA, "r1")).toEqual(["google"]);
    expect(takeConnectOffers(BRUNO, "r1")).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith("ada google mailbox moved from=+39…1111 to=+39…2222");
  });

  it("writes the note in the former owner's language", async () => {
    accounts.byOwner.set(ANNA, { email: "shared@example.com" });
    openAdaMemoryIfExistsFromApi.mockResolvedValue({
      readProfile: async () => ({ language: "English" }),
    });
    const { api, sent } = setup();
    await releaseMailboxFromOtherOwners(api, BRUNO, "shared@example.com");
    expect(sent[0]?.text).toContain("this mailbox was connected from another number");
  });

  it("does nothing when no other number has the mailbox, including when the same number reconnects", async () => {
    accounts.byOwner.set(BRUNO, { email: "bruno@example.com" });
    accounts.byOwner.set(CARLA, { email: "carla@example.com" });
    const { api, sent } = setup();
    await releaseMailboxFromOtherOwners(api, BRUNO, "bruno@example.com");
    expect(clearAccount).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("still frees the mailbox when the note cannot be sent, and says so", async () => {
    accounts.byOwner.set(ANNA, { email: "shared@example.com" });
    const { api, logger } = setup();
    (api.runtime.channel.outbound.loadAdapter as unknown) = async () => ({
      sendText: async () => {
        throw new Error("kapso down");
      },
    });
    await releaseMailboxFromOtherOwners(api, BRUNO, "shared@example.com");
    expect(accounts.byOwner.has(ANNA)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "ada mailbox moved note not sent to=+39…1111: kapso down",
    );
  });
});
