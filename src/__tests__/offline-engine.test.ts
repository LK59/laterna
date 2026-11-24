import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { OfflineEngine } from "@/lib/offline/offlineEngine";

/**
 * Le moteur du lecteur hors ligne face aux sauts rapides (relecture du 19/10/2026) : deux appuis sur
 * +10 s faisaient vider le tampon pendant qu'un ajout courait — le navigateur lève alors
 * `InvalidStateError`, et la lecture s'arrêtait sur « Lecture impossible ». Le faux tampon ci-dessous
 * refuse exactement ce que refuse un vrai : toute opération pendant qu'une autre est en cours.
 */

const file = new Uint8Array(fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/offline/jellyfin-like.mp4")));

class FakeSourceBuffer extends EventTarget {
  updating = false;
  ops: string[] = [];
  private run(name: string) {
    if (this.updating) throw new DOMException(`${name} pendant une opération`, "InvalidStateError");
    this.updating = true;
    this.ops.push(name);
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }, 3);
  }
  appendBuffer() {
    this.run("append");
  }
  remove() {
    this.run("remove");
  }
}

let buffer: FakeSourceBuffer;
class FakeMediaSource extends EventTarget {
  readyState = "open";
  duration = NaN;
  static isTypeSupported = () => true;
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(new Event("sourceopen")), 0);
  }
  addSourceBuffer() {
    buffer = new FakeSourceBuffer();
    return buffer;
  }
  endOfStream() {
    this.readyState = "ended";
  }
}

function fakeVideo() {
  const video = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(video, {
    currentTime: 0,
    seeking: false,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    srcObject: null,
    disableRemotePlayback: false,
    removeAttribute: () => {},
    load: () => {},
  });
  return video as unknown as HTMLVideoElement;
}

afterEach(() => vi.unstubAllGlobals());

describe("OfflineEngine", () => {
  it("des sauts rapides passent un par un : jamais d'ajout ni de vidage pendant une opération", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    const errors: string[] = [];
    const video = fakeVideo();
    const engine = new OfflineEngine(
      video,
      { read: async (o, l) => file.slice(o, Math.min(file.length, o + l)), available: () => file.length, complete: () => true },
      null,
      { onError: (m) => errors.push(m) }
    );
    await engine.open(0);
    for (const t of [3, 1, 4, 2, 5]) {
      (video as unknown as { currentTime: number }).currentTime = t;
      video.dispatchEvent(new Event("seeking"));
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(errors).toEqual([]);
    expect(buffer.ops.filter((o) => o === "remove").length).toBeGreaterThan(0);
    expect(buffer.ops.filter((o) => o === "append").length).toBeGreaterThan(1);
    engine.close();
  });
});

/**
 * L'en-tête qui ne répond pas (iPad sous Chrome, 24/11/2026) : ouvert juste après la fermeture d'une
 * autre lecture, le navigateur ne rendait jamais l'ajout de l'en-tête et l'écran disait « bloqué à
 * l'étape en-tête confié au navigateur » ; un nouvel essai une minute plus tard passait. Le moteur
 * démonte cette MediaSource et recommence une fois après 2 s — une seule.
 */
describe("OfflineEngine — en-tête sans réponse", () => {
  const source = { read: async (o: number, l: number) => file.slice(o, Math.min(file.length, o + l)), available: () => file.length, complete: () => true };

  /** Une MediaSource dont les `silent` premiers tampons ne rendent jamais leur premier ajout. */
  function stubSilent(silent: number) {
    let made = 0;
    const loads: number[] = [];
    class SilentFirst extends FakeMediaSource {
      addSourceBuffer() {
        const b = super.addSourceBuffer();
        if (made++ < silent) b.appendBuffer = () => {};
        return b;
      }
    }
    vi.stubGlobal("MediaSource", SilentFirst);
    return { made: () => made, loads };
  }

  it("recommence une fois, avec une MediaSource neuve, et ouvre", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubSilent(1);
      const traces: string[] = [];
      const video = fakeVideo();
      const loads = vi.fn();
      (video as unknown as { load: () => void }).load = loads;
      const engine = new OfflineEngine(video, source, null, { onError: () => {}, trace: (l) => traces.push(l) });
      const opened = engine.open(0);
      await vi.advanceTimersByTimeAsync(10_000 + 2_000 + 100);
      await expect(opened).resolves.toContain("video/mp4");
      expect(stub.made()).toBe(2);
      expect(loads).toHaveBeenCalledTimes(1); // la première MediaSource rendue avant la seconde
      expect(engine.stage).toBe("premier fragment");
      expect(traces.some((t) => t.includes("nouvel essai"))).toBe(true);
      engine.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pas de troisième essai : deux silences font l'erreur nommée d'avant", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubSilent(2);
      const engine = new OfflineEngine(fakeVideo(), source, null, { onError: () => {} });
      const opened = engine.open(0);
      const settled = opened.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(settled).resolves.toBe("bloqué à l'étape « en-tête confié au navigateur »");
      expect(stub.made()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un refus franc du navigateur ne repasse pas", async () => {
    class Refusing extends FakeMediaSource {
      addSourceBuffer() {
        const b = super.addSourceBuffer();
        b.appendBuffer = () => setTimeout(() => b.dispatchEvent(new Event("error")), 1);
        return b;
      }
    }
    let made = 0;
    class Counting extends Refusing {
      constructor() {
        super();
        made++;
      }
    }
    vi.stubGlobal("MediaSource", Counting);
    const engine = new OfflineEngine(fakeVideo(), source, null, { onError: () => {} });
    await expect(engine.open(0)).rejects.toThrow("le navigateur a refusé un fragment");
    expect(made).toBe(1);
  });

  it("fermé pendant le répit : pas de second attachement", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubSilent(1);
      const engine = new OfflineEngine(fakeVideo(), source, null, { onError: () => {} });
      const settled = engine.open(0).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(10_500);
      engine.close();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(settled).resolves.toContain("bloqué à l'étape");
      expect(stub.made()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
