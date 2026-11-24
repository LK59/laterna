// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * L'en-tête du fichier lu pendant que la fiche est à l'écran (`sheetHeaderWarmup.ts`) : rien avant
 * une seconde, un seul fichier à la fois, tout arrêté à la fermeture, et jamais au prix du relais
 * qu'un film tout juste fermé a laissé à sa réouverture.
 */

const h = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  openMediaFile: vi.fn(async () => ({ tracks: [] })),
  info: vi.fn(async (id: string) => ({ streamUrl: `/api/jellyfin/stream/${id}/stream.mkv?static=true`, sizeBytes: 5000, fileVersion: "etag-1" as string | undefined })),
  openDisk: vi.fn(async () => null as unknown),
  account: "louis" as string | null,
  held: null as string | null,
  prepared: new Set<string>(),
  state: null as Promise<{ resumeSeconds: number; positionUnknown?: true } | null> | null,
  zone: vi.fn((): { from: number; to: number } | null => null),
}));
vi.mock("@/lib/webcodecs/byteSource", () => ({
  HttpByteSource: { open: (...a: unknown[]) => h.open(...a) },
  holdsHandover: (url: string) => url === h.held,
  holdsPrepared: (key: string) => h.prepared.has(key),
  CHUNK_SIZE: 1 << 20,
}));
vi.mock("@/lib/playbackPrefetch", () => ({ peekPrefetchedPlaybackState: () => h.state }));
vi.mock("@/lib/webcodecs/matroska", () => ({ keptRangeAt: (...a: unknown[]) => h.zone(...(a as [])) }));
vi.mock("@/lib/webcodecs/mediaFile", async (importOriginal) => ({
  mediaHeaderKey: (await importOriginal<typeof import("@/lib/webcodecs/mediaFile")>()).mediaHeaderKey,
  openMediaFile: (...a: unknown[]) => h.openMediaFile(...(a as [])),
}));
vi.mock("@/lib/directInfo", () => ({ fetchDirectInfo: (id: string) => h.info(id) }));
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => h.account }));
vi.mock("@/lib/resumeCache/diskChunks", () => ({ openDiskChunks: (...a: unknown[]) => h.openDisk(...(a as [])) }));

import { forgetSheetHeaderWarmups, scheduleSheetHeaderWarmup, SHEET_WARMUP_DELAY_MS } from "@/lib/sheetHeaderWarmup";

/** Une source dont chaque fermeture est comptée, et dont la lecture d'en-tête peut rester pendante. */
function fakeSource() {
  const source = {
    size: 100 << 20,
    close: vi.fn((leaveForNext?: boolean) => h.close(leaveForNext)),
    // La vraie ferme la source (`close(false)`) et laisse ses morceaux sous la version du fichier.
    closePrepared: vi.fn(() => h.close(false)),
    read: vi.fn(async () => new Uint8Array(1)),
    withoutReadahead: vi.fn(() => source),
  };
  return source;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  forgetSheetHeaderWarmups();
  h.account = "louis";
  h.held = null;
  h.prepared = new Set();
  h.state = Promise.resolve(null);
  h.zone.mockReset().mockReturnValue(null);
  h.open.mockImplementation(async () => fakeSource());
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("l'en-tête préparé depuis la fiche", () => {
  it("après une seconde : lit l'en-tête sous le nom que l'ouverture cherchera, puis ferme la source en gardant ses morceaux sous ce nom, sans les laisser au relais", async () => {
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.open).toHaveBeenCalledWith("/api/jellyfin/stream/film/stream.mkv?static=true", 5000, null);
    expect(h.openMediaFile).toHaveBeenCalledWith(expect.anything(), "/api/jellyfin/stream/film/stream.mkv?static=true#etag-1");
    const source = (await h.open.mock.results.at(-1)!.value) as ReturnType<typeof fakeSource>;
    expect(source.closePrepared).toHaveBeenCalledWith("/api/jellyfin/stream/film/stream.mkv?static=true#etag-1");
    expect(h.close).toHaveBeenCalledWith(false);
  });

  it("une fiche fermée avant la seconde ne lit rien", async () => {
    const cancel = scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS - 1);
    cancel();
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.info).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("la fermeture de la fiche coupe une lecture en cours", async () => {
    let finish: (v: { tracks: never[] }) => void = () => {};
    h.openMediaFile.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const cancel = scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.openMediaFile).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
    cancel();
    expect(h.close).toHaveBeenCalledWith(false);
    finish({ tracks: [] });
    await flush();
  });

  it("un fichier à la fois : la fiche suivante arrête la lecture de la précédente", async () => {
    h.openMediaFile.mockImplementationOnce(() => new Promise(() => {}));
    scheduleSheetHeaderWarmup("premier");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.close).not.toHaveBeenCalled();
    scheduleSheetHeaderWarmup("second");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    // La première source est fermée dès que la seconde part, puis la seconde à la fin de sa lecture,
    // en gardant ses morceaux (`closePrepared` ; la vraie fermeture qui suit ne fait alors plus rien).
    const [first, second] = (await Promise.all(h.open.mock.results.map((r) => r.value))) as ReturnType<typeof fakeSource>[];
    expect(first.close).toHaveBeenCalledWith(false);
    expect(first.closePrepared).not.toHaveBeenCalled();
    expect(second.closePrepared).toHaveBeenCalledWith("/api/jellyfin/stream/second/stream.mkv?static=true#etag-1");
    expect(h.openMediaFile).toHaveBeenLastCalledWith(expect.anything(), "/api/jellyfin/stream/second/stream.mkv?static=true#etag-1");
  });

  it("ne touche pas au relais qu'un film tout juste fermé laisse à sa réouverture", async () => {
    h.held = "/api/jellyfin/stream/film/stream.mkv?static=true";
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("rien quand l'appareil économise ses données, ni quand la page est cachée", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.info).not.toHaveBeenCalled();
  });

  it("un titre gardé sur l'appareil se lit depuis l'appareil", async () => {
    const disk = { kind: "disque" };
    h.openDisk.mockResolvedValueOnce(disk);
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.open).toHaveBeenCalledWith(expect.any(String), 5000, disk);
  });

  it("un échec ne lève rien : l'ouverture lira l'en-tête elle-même", async () => {
    h.openMediaFile.mockRejectedValueOnce(new Error("réseau"));
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.close).toHaveBeenCalledWith(false);
  });
});

describe("ouverture rapide : morceaux gardés et zone de reprise (DECISIONS §200)", () => {
  const KEY = "/api/jellyfin/stream/film/stream.mkv?static=true#etag-1";
  const lastSource = () => h.open.mock.results.at(-1)!.value as Promise<ReturnType<typeof fakeSource>>;

  it("sans version de fichier : rien n'est gardé, la source meurt avec ses octets", async () => {
    h.info.mockResolvedValueOnce({ streamUrl: "/api/jellyfin/stream/film/stream.mkv?static=true", sizeBytes: 5000, fileVersion: undefined });
    h.state = Promise.resolve({ resumeSeconds: 600 });
    h.zone.mockReturnValue({ from: 40 << 20, to: (41 << 20) - 1 });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    const source = await lastSource();
    expect(source.closePrepared).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledWith(false);
  });

  it("titre jamais commencé : les morceaux de l'en-tête sont gardés sous la version du fichier, sans zone de reprise", async () => {
    h.state = Promise.resolve({ resumeSeconds: 0 });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    const source = await lastSource();
    expect(source.closePrepared).toHaveBeenCalledWith(KEY);
    expect(source.read).not.toHaveBeenCalled();
  });

  it("titre en cours : la zone de reprise est lue, un morceau avant, sept au plus", async () => {
    h.state = Promise.resolve({ resumeSeconds: 600 });
    h.zone.mockReturnValue({ from: 40 << 20, to: (60 << 20) - 1 });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    const source = await lastSource();
    expect(source.read.mock.calls.map((c) => (c as unknown as number[])[0] >> 20)).toEqual([39, 40, 41, 42, 43, 44, 45]);
    expect(source.closePrepared).toHaveBeenCalledWith(KEY);
  });

  it("une position inconnue (Jellyfin muet) ne lit pas de zone", async () => {
    h.state = Promise.resolve({ resumeSeconds: 600, positionUnknown: true });
    h.zone.mockReturnValue({ from: 40 << 20, to: (41 << 20) - 1 });
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect((await lastSource()).read).not.toHaveBeenCalled();
  });

  it("déjà préparé sous cette version : rouvrir la fiche ne relit rien", async () => {
    h.prepared.add(KEY);
    scheduleSheetHeaderWarmup("film");
    await vi.advanceTimersByTimeAsync(SHEET_WARMUP_DELAY_MS);
    await flush();
    expect(h.open).not.toHaveBeenCalled();
  });
});
