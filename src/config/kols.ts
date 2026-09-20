import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertIsAddress } from "@solana/kit";
import { config } from "./index";
import { KolProfile } from "../types";

// Legacy watchlist imported by the original author in May 2026.
// Labels and tiers are operator-supplied, not verified ownership or performance.
// Historical numeric seed arguments remain for source history only and are
// deliberately ignored: unavailable performance metrics must stay unknown.

function kol(
  address: string,
  label: string,
  tier: "s" | "a" | "b",
  winRate: number,
  holdHours: number,
  rugAvoid: number,
  trades: number,
): KolProfile {
  return {
    address,
    label,
    tier,
    historicalWinRate: 0.5,
    avgHoldDurationMs: 0,
    rugAvoidanceRate: 0.5,
    totalTrackedTrades: 0,
    metricsSource: "unknown",
    addedAt: Date.now(),
  };
}

const kolDatabase: KolProfile[] = [
  // ═══════════════════════════════════════════════
  // S-TIER — Top earners, confirmed active traders
  // ═══════════════════════════════════════════════

  // Ansem (@blknoiz06) — confirmed via Datawallet, BlockBeats, GMGN, Cielo
  kol(
    "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm",
    "@ansem",
    "s",
    0.72,
    4,
    0.94,
    847,
  ),

  // Kolscan leaderboard #1 — "theo"
  kol(
    "Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt",
    "@theo",
    "s",
    0.47,
    1,
    0.85,
    118,
  ),

  // Kolscan leaderboard #2 — "Nyhrox"
  kol(
    "6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC",
    "@Nyhrox",
    "s",
    0.45,
    2,
    0.88,
    22,
  ),

  // Kolscan leaderboard #3 — "N'o"
  kol(
    "Di75xbVUg3u1qcmZci3NcZ8rjFMj7tsnYEoFdEMjS4ow",
    "@No",
    "s",
    0.52,
    3,
    0.86,
    21,
  ),

  // Kolscan leaderboard #4 — "Cented"
  kol(
    "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o",
    "@Cented",
    "s",
    0.56,
    1,
    0.82,
    183,
  ),

  // Kolscan leaderboard #5 — "Cupsey"
  kol(
    "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f",
    "@Cupsey",
    "s",
    0.38,
    1,
    0.8,
    175,
  ),

  // Kolscan #10 — "Letterbomb"
  kol(
    "BtMBMPkoNbnLF9Xn552guQq528KKXcsNBNNBre3oaQtr",
    "@Letterbomb",
    "s",
    0.36,
    2,
    0.83,
    234,
  ),

  // Kolscan live feed — "Leens"
  kol(
    "LeenseyyUU3ccdBPCFCrrZ8oKU2B3T2uToGGZ7eVABY",
    "@Leens",
    "s",
    0.55,
    1,
    0.87,
    320,
  ),

  // ═══════════════════════════════════════════════
  // A-TIER — Consistent performers from leaderboard
  // ═══════════════════════════════════════════════

  // Kolscan #6 — "chester"
  kol(
    "PMJA8UQDyWTFw2Smhyp9jGA6aTaP7jKHR7BPudrgyYN",
    "@chester",
    "a",
    0.35,
    2,
    0.81,
    130,
  ),

  // Kolscan #7 — "Walta"
  kol(
    "39q2g5tTQn9n7KnuapzwS2smSx3NGYqBoea11tBjsGEt",
    "@Walta",
    "a",
    0.5,
    4,
    0.9,
    4,
  ),

  // Kolscan #8 — "Publix"
  kol(
    "86AEJExyjeNNgcp7GrAvCXTDicf5aGWgoERbXFiG1EdD",
    "@Publix",
    "a",
    0.2,
    3,
    0.78,
    25,
  ),

  // Kolscan #9 — "Brox"
  kol(
    "7VBTpiiEjkwRbRGHJFUz6o5fWuhPFtAmy8JGhNqwHNnn",
    "@Brox",
    "a",
    0.5,
    6,
    0.92,
    2,
  ),

  // Kolscan #11 — "Smokez"
  kol(
    "5t9xBNuDdGTGpjaPTx6hKd7sdRJbvtKS8Mhq6qVbo8Qz",
    "@Smokez",
    "a",
    0.38,
    2,
    0.82,
    21,
  ),

  // Kolscan #12 — "Jijo"
  kol(
    "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk",
    "@Jijo",
    "a",
    0.53,
    3,
    0.85,
    17,
  ),

  // Kolscan #13 — "zeropnl"
  kol(
    "4xY9T1Q7foJzJsJ6YZDSsfp9zkzeZsXnxd45SixduMmr",
    "@zeropnl",
    "a",
    0.29,
    1,
    0.76,
    31,
  ),

  // Kolscan #14 — "Hesi"
  kol(
    "FpD6n8gfoZNxyAN6QqNH4TFQdV9vZEgcv5W4H2YL8k4X",
    "@Hesi",
    "a",
    0.38,
    2,
    0.8,
    48,
  ),

  // Kolscan #15 — "noob mini"
  kol(
    "AGqjivJr1dSv73TVUvdtqAwogzmThzvYMVXjGWg2FYLm",
    "@noob_mini",
    "a",
    0.29,
    2,
    0.79,
    35,
  ),

  // Kolscan #16 — "Scharo"
  kol(
    "4sAUSQFdvWRBxR8UoLBYbw8CcXuwXWxnN8pXa4mtm5nU",
    "@Scharo",
    "a",
    0.39,
    1,
    0.78,
    136,
  ),

  // Kolscan #17 — "Pullup"
  kol(
    "65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE",
    "@Pullup",
    "a",
    0.5,
    8,
    0.91,
    2,
  ),

  // Kolscan #18 — "tech"
  kol(
    "5d3jQcuUvsuHyZkhdp78FFqc7WogrzZpTtec1X9VNkuE",
    "@tech",
    "a",
    0.33,
    3,
    0.82,
    6,
  ),

  // Kolscan #19 — "Earl"
  kol(
    "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm",
    "@Earl",
    "a",
    0.21,
    2,
    0.75,
    34,
  ),

  // Kolscan #20 — "Kadenox"
  kol(
    "B32QbbdDAyhvUQzjcaM5j6ZVKwjCxAwGH5Xgvb9SJqnC",
    "@Kadenox",
    "a",
    0.58,
    3,
    0.84,
    52,
  ),

  // Kolscan #21 — "Qavec"
  kol(
    "gangJEP5geDHjPVRhDS5dTF5e6GtRvtNogMEEVs91RV",
    "@Qavec",
    "a",
    0.53,
    1,
    0.8,
    66,
  ),

  // Kolscan #22 — "Otta"
  kol(
    "As7HjL7dzzvbRbaD3WCun47robib2kmAKRXMvjHkSMB5",
    "@Otta",
    "a",
    0.8,
    4,
    0.9,
    5,
  ),

  // Kolscan #23 — "Naruza"
  kol(
    "ASVzakePP6GNg9r95d4LPZHJDMXun6L6E4um4pu5ybJk",
    "@Naruza",
    "a",
    0.73,
    2,
    0.86,
    22,
  ),

  // Kolscan #24 — "Trey"
  kol(
    "831yhv67QpKqLBJjbmw2xoDUeeFHGUx8RnuRj9imeoEs",
    "@Trey",
    "a",
    0.3,
    1,
    0.77,
    54,
  ),

  // Kolscan #25 — "Gfree"
  kol(
    "4yo9CUuTBbds9NFhZd4MzPiZZkUvveXdTnAH8qMsE8ku",
    "@Gfree",
    "a",
    0.35,
    2,
    0.79,
    34,
  ),

  // ═══════════════════════════════════════════════
  // B-TIER — Active traders, mid-volume
  // ═══════════════════════════════════════════════

  // Kolscan #26 — "deceasedcold_"
  kol(
    "5JrDgnED5QFiaE8Znny2S9GwCeDK2pLYjMfWmjKogs3w",
    "@deceasedcold",
    "b",
    0.37,
    2,
    0.78,
    27,
  ),

  // Kolscan #27 — "Tom"
  kol(
    "CEUA7zVoDRqRYoeHTP58UHU6TR8yvtVbeLrX1dppqoXJ",
    "@Tom",
    "b",
    0.57,
    4,
    0.85,
    7,
  ),

  // Kolscan #28 — "Schoen"
  kol(
    "5hAgYC8TJCcEZV7LTXAzkTrm7YL29YXyQQJPCNrG84zM",
    "@Schoen",
    "b",
    0.42,
    3,
    0.82,
    12,
  ),

  // Kolscan #29 — "shah"
  kol(
    "7xwDKXNG9dxMsBSCmiAThp7PyDaUXbm23irLr7iPeh7w",
    "@shah",
    "b",
    0.17,
    1,
    0.72,
    59,
  ),

  // Kolscan #30 — "zhynx"
  kol(
    "zhYnXqK3MNSmwS3yxSvPmY5kUa1n2WUaCJgYUDrAHkL",
    "@zhynx",
    "b",
    0.5,
    6,
    0.88,
    2,
  ),

  // Kolscan #31 — "Gucci"
  kol(
    "YvEsBWpHK5PJ6Q8m4YrocwKeWys1NG67pbgi73UPnuX",
    "@Gucci",
    "b",
    0.22,
    2,
    0.76,
    18,
  ),

  // Kolscan #32 — "Mr. Frog"
  kol(
    "4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh",
    "@MrFrog",
    "b",
    0.58,
    1,
    0.83,
    33,
  ),

  // Kolscan #33 — "Wugi"
  kol(
    "862TYSvRYoiHAK3F3WwTRYAfuGiQaGdxedN9AGvRGWo2",
    "@Wugi",
    "b",
    1.0,
    4,
    0.95,
    2,
  ),

  // Kolscan #34 — "Limfork.eth"
  kol(
    "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB",
    "@Limfork",
    "b",
    0.34,
    2,
    0.78,
    53,
  ),

  // Kolscan #35 — "Mel"
  kol(
    "36A6mEN5rYJdVTb6fMqVvG6ez8g2mTYdr1omWcQ1kDKG",
    "@Mel",
    "b",
    1.0,
    3,
    0.9,
    11,
  ),

  // Kolscan #36 — "milito"
  kol(
    "EeXvxkcGqMDZeTaVeawzxm9mbzZwqDUMmfG3bF7uzumH",
    "@milito",
    "b",
    0.57,
    2,
    0.81,
    37,
  ),

  // Kolscan #37 — "Heyitsyolo"
  kol(
    "Av3xWHJ5EsoLZag6pr7LKbrGgLRTaykXomDD5kBhL9YQ",
    "@Heyitsyolo",
    "b",
    0.41,
    1,
    0.77,
    113,
  ),

  // Kolscan #38 — "Dusty"
  kol(
    "B799XD2RtgkxYRvv5Q9CFnSpVifrsJErWz6MpvBdYFdR",
    "@Dusty",
    "b",
    1.0,
    5,
    0.92,
    2,
  ),

  // Kolscan #39 — "Pain"
  kol(
    "J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa",
    "@Pain",
    "b",
    0.5,
    2,
    0.82,
    16,
  ),

  // Kolscan #40 — "Trenchman"
  kol(
    "Hw5UKBU5k3YudnGwaykj5E8cYUidNMPuEewRRar5Xoc7",
    "@Trenchman",
    "b",
    0.4,
    1,
    0.76,
    60,
  ),

  // Kolscan #41 — "crayohla"
  kol(
    "GDoG4tdbx8qkpECQKF5MebbEDpFJn6H739psqgoTG3aN",
    "@crayohla",
    "b",
    0.26,
    1,
    0.73,
    54,
  ),

  // Kolscan #42 — "eq"
  kol(
    "7w7f4P284zJhv3zotjCUmaNsZSsrHQKtpXGBJFq8gdzq",
    "@eq",
    "b",
    1.0,
    3,
    0.9,
    1,
  ),

  // Kolscan #43 — "ROWDY"
  kol(
    "DKgvpfttzmJqZXdavDwTxwSVkajibjzJnN2FA99dyciK",
    "@ROWDY",
    "b",
    1.0,
    4,
    0.9,
    1,
  ),

  // Kolscan #44 — "Putrick"
  kol(
    "AVjEtg2ECYKXYeqdRQXvaaAZBjfTjYuSMTR4WLhKoeQN",
    "@Putrick",
    "b",
    0.46,
    2,
    0.79,
    39,
  ),

  // Kolscan #45 — "Coler"
  kol(
    "99xnE2zEFi8YhmKDaikc1EvH6ELTQJppnqUwMzmpLXrs",
    "@Coler",
    "b",
    0.41,
    1,
    0.77,
    64,
  ),

  // Kolscan #46 — "Reljoo"
  kol(
    "FsG3BaPmRTdSrPaivbgJsFNCCa8cPfkUtk8VLWXkHpHP",
    "@Reljoo",
    "b",
    0.25,
    3,
    0.8,
    8,
  ),

  // Kolscan #47 — "Numer0"
  kol(
    "A3W8psibkTUvjxs4LRscbnjux6TFDXdvD4m4GsGpQ2KJ",
    "@Numer0",
    "b",
    0.63,
    2,
    0.84,
    16,
  ),

  // Kolscan #48 — "Fozzy"
  kol(
    "B9oKseVKRntTvfADyaUoH7oVmoyVbBfUf4NKyQc4KK2D",
    "@Fozzy",
    "b",
    0.33,
    2,
    0.78,
    15,
  ),

  // Kolscan #49 — "rambo"
  kol(
    "2net6etAtTe3Rbq2gKECmQwnzcKVXRaLcHy2Zy1iCiWz",
    "@rambo",
    "b",
    0.22,
    1,
    0.75,
    9,
  ),

  // Kolscan #50 — "Felix"
  kol(
    "3uz65G8e463MA5FxcSu1rTUyWRtrRLRZYskKtEHHj7qn",
    "@Felix",
    "b",
    0.65,
    2,
    0.83,
    20,
  ),

  // Kolscan live feed — "Kimba"
  kol(
    "7mHqL9GzGnbsYLoHLDzB7FiHAZbND2CZCJYFvU9PU1d3",
    "@Kimba",
    "b",
    0.55,
    2,
    0.81,
    45,
  ),

  // Kolscan live feed — "Cope"
  kol(
    "23wQ7bodYreW3qhnh2YrW8dMkTYSkHHJqGcsiYEJS3Pr",
    "@Cope",
    "b",
    0.48,
    1,
    0.79,
    60,
  ),

  // Kolscan live feed — "unprofitable"
  kol(
    "DYmsQudNqJyyDvq86XmzAvrU9T7xwfQEwh6gPQw9TPNF",
    "@unprofitable",
    "b",
    0.4,
    0.5,
    0.72,
    320,
  ),

  // ═══════════════════════════════════════════════
  // NOTABLE — Ecosystem figures (lower trade freq)
  // ═══════════════════════════════════════════════

  // toly.sol domain owner — speculated Anatoly Yakovenko
  kol(
    "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdRrbLP6TU",
    "@toly",
    "b",
    0.5,
    720,
    0.95,
    45,
  ),

  // Rumored Anatoly staking wallet — 136K+ SOL
  kol(
    "9QgXqKHSBhJHkp2SkTbzvN7e3CKfMGn1CdahS2NQLBRG",
    "@toly_staking",
    "b",
    0.5,
    2160,
    0.99,
    12,
  ),
];

export class KolStore {
  private kols: Map<string, KolProfile> = new Map();

  constructor() {
    for (const k of kolDatabase) {
      try {
        assertIsAddress(k.address);
        this.kols.set(k.address, { ...k });
      } catch {
        /* Ignore invalid legacy seeds. */
      }
    }
    if (config.dataDir && existsSync(join(config.dataDir, "wallets.json"))) {
      const saved: KolProfile[] = JSON.parse(
        readFileSync(join(config.dataDir, "wallets.json"), "utf8"),
      );
      for (const k of saved) {
        assertIsAddress(k.address);
        this.kols.set(k.address, k);
      }
    }
  }

  private persist(): void {
    if (!config.dataDir) return;
    mkdirSync(config.dataDir, { recursive: true });
    const file = join(config.dataDir, "wallets.json");
    writeFileSync(file + ".tmp", JSON.stringify(this.getAll(), null, 2), {
      mode: 0o600,
    });
    renameSync(file + ".tmp", file);
  }

  get(address: string): KolProfile | undefined {
    return this.kols.get(address);
  }

  getAll(): KolProfile[] {
    return Array.from(this.kols.values());
  }

  getAllAddresses(): string[] {
    return Array.from(this.kols.keys());
  }

  add(kol: KolProfile): void {
    const previous = this.kols.get(kol.address);
    this.kols.set(kol.address, kol);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.kols.set(kol.address, previous);
      else this.kols.delete(kol.address);
      throw error;
    }
  }

  has(address: string): boolean {
    return this.kols.has(address);
  }

  size(): number {
    return this.kols.size;
  }

  updateStats(address: string, won: boolean): void {
    const k = this.kols.get(address);
    if (!k) return;
    const total = k.totalTrackedTrades + 1;
    const wins =
      Math.round(k.historicalWinRate * k.totalTrackedTrades) + (won ? 1 : 0);
    k.historicalWinRate = wins / total;
    k.totalTrackedTrades = total;
  }
}
