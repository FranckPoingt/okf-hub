export type SaveState = "saving" | "saved" | "failed";

type PendingDraft = {
  markdown: string;
  version: number;
  dirty: boolean;
  state: SaveState;
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
};

/** Coalesces edits while serializing checkpoints for each document. */
export class DraftSaveQueue {
  private drafts = new Map<string, PendingDraft>();

  constructor(
    private save: (id: string, markdown: string) => Promise<void>,
    private onState: (id: string, state: SaveState) => void,
    private delay = 300,
  ) {}

  stage(id: string, markdown: string) {
    const draft = this.drafts.get(id) ?? {
      markdown,
      version: 0,
      dirty: false,
      state: "saved" as SaveState,
    };
    if (!draft.dirty && draft.version && draft.markdown === markdown) return;
    draft.markdown = markdown;
    draft.version++;
    draft.dirty = true;
    this.drafts.set(id, draft);
    this.setState(id, draft, "saving");
    if (draft.timer) clearTimeout(draft.timer);
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      void this.run(id, draft).catch(() => {});
    }, this.delay);
  }

  /** Records a server checkpoint only when local edits have already drained. */
  accept(id: string, markdown: string) {
    const draft = this.drafts.get(id);
    if (draft?.dirty || draft?.running) return false;
    if (draft?.timer) clearTimeout(draft.timer);
    this.drafts.set(id, {
      markdown,
      version: 1,
      dirty: false,
      state: "saved",
    });
    return true;
  }

  /** False when the editor's serialization is just the accepted checkpoint. */
  differs(id: string, markdown: string) {
    const draft = this.drafts.get(id);
    return Boolean(
      draft?.dirty || !draft?.version || draft.markdown !== markdown,
    );
  }

  state(id: string) {
    return this.drafts.get(id)?.state ?? "saved";
  }

  error(id: string | null) {
    return id ? this.drafts.get(id)?.error : undefined;
  }

  hasPending() {
    return Array.from(this.drafts.values()).some((draft) => draft.dirty);
  }

  async flush(id: string | null) {
    const draft = id ? this.drafts.get(id) : undefined;
    if (!id || !draft) return true;
    if (draft.timer) clearTimeout(draft.timer);
    draft.timer = undefined;
    try {
      if (draft.running) await draft.running;
      if (draft.dirty) await this.run(id, draft);
      return !draft.dirty;
    } catch {
      return false;
    }
  }

  async flushAll() {
    const results = await Promise.all(
      Array.from(this.drafts.keys(), (id) => this.flush(id)),
    );
    return results.every(Boolean);
  }

  clear() {
    for (const draft of this.drafts.values()) {
      if (draft.timer) clearTimeout(draft.timer);
    }
    this.drafts.clear();
  }

  private setState(id: string, draft: PendingDraft, state: SaveState) {
    draft.state = state;
    if (this.drafts.get(id) === draft) this.onState(id, state);
  }

  private run(id: string, draft: PendingDraft): Promise<void> {
    if (draft.running) return draft.running;
    this.setState(id, draft, "saving");
    const running = (async () => {
      while (draft.dirty && this.drafts.get(id) === draft) {
        const version = draft.version;
        try {
          await this.save(id, draft.markdown);
        } catch (error) {
          draft.error = error instanceof Error
            ? error.message
            : "Could not save draft";
          this.setState(id, draft, "failed");
          throw error;
        }
        draft.error = undefined;
        if (draft.version === version) draft.dirty = false;
      }
      if (draft.timer) clearTimeout(draft.timer);
      draft.timer = undefined;
      this.setState(id, draft, "saved");
    })();
    draft.running = running;
    void running.finally(() => {
      if (draft.running === running) draft.running = undefined;
    }).catch(() => {});
    return running;
  }
}
