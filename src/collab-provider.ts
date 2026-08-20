import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";

export type ConnectionStatus = "connecting" | "syncing" | "online" | "offline";
export type Collaborator = { name: string; color: string };

const DOCUMENT_UPDATE = 0;
const AWARENESS_UPDATE = 1;

function packet(type: number, payload: Uint8Array) {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = type;
  frame.set(payload, 1);
  return frame;
}

export class DenoCollabProvider {
  readonly awareness: Awareness;
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 400;
  private active = false;
  private readonly syncedListeners = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly doc: Y.Doc,
    user: Collaborator,
    private readonly onStatus: (status: ConnectionStatus) => void,
    private readonly onCollaborators: (users: Collaborator[]) => void,
  ) {
    this.awareness = new Awareness(doc);
    this.awareness.setLocalStateField("user", user);
    this.doc.on("update", this.sendDocumentUpdate);
    this.awareness.on("update", this.sendAwarenessUpdate);
    this.awareness.on("change", this.reportCollaborators);
    this.reportCollaborators();
  }

  onSynced(listener: () => void) {
    this.syncedListeners.add(listener);
  }

  connect() {
    this.active = true;
    this.open();
  }

  stop() {
    this.active = false;
    if (this.reconnectTimer) globalThis.clearTimeout(this.reconnectTimer);
    this.syncedListeners.clear();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.close();
      this.socket = undefined;
    }
  }

  destroy() {
    this.stop();
    this.awareness.setLocalState(null);
    this.doc.off("update", this.sendDocumentUpdate);
    this.awareness.off("update", this.sendAwarenessUpdate);
    this.awareness.off("change", this.reportCollaborators);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private open() {
    if (!this.active || this.socket?.readyState === WebSocket.OPEN) return;
    this.onStatus("connecting");
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.retryDelay = 400;
      this.onStatus("syncing");
      socket.send(packet(DOCUMENT_UPDATE, Y.encodeStateAsUpdate(this.doc)));
      socket.send(
        packet(
          AWARENESS_UPDATE,
          encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
        ),
      );
    };

    socket.onmessage = async (event) => {
      if (!this.active) return;
      if (event.data === "synced") {
        this.onStatus("online");
        this.syncedListeners.forEach((listener) => listener());
        return;
      }
      const data = event.data instanceof Blob
        ? new Uint8Array(await event.data.arrayBuffer())
        : new Uint8Array(event.data as ArrayBuffer);
      if (!this.active || this.socket !== socket) return;
      if (data[0] === DOCUMENT_UPDATE) {
        Y.applyUpdate(this.doc, data.subarray(1), this);
      } else if (data[0] === AWARENESS_UPDATE) {
        applyAwarenessUpdate(this.awareness, data.subarray(1), this);
      }
    };

    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = undefined;
      if (!this.active) return;
      if (event.code === 4009) {
        globalThis.location.reload();
        return;
      }
      this.onStatus("offline");
      this.reconnectTimer = globalThis.setTimeout(
        () => this.open(),
        this.retryDelay,
      );
      this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
    };
  }

  private sendDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(packet(DOCUMENT_UPDATE, update));
  };

  private sendAwarenessUpdate = (
    { added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    },
    origin: unknown,
  ) => {
    if (origin === this || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      packet(
        AWARENESS_UPDATE,
        encodeAwarenessUpdate(this.awareness, [
          ...added,
          ...updated,
          ...removed,
        ]),
      ),
    );
  };

  private reportCollaborators = () => {
    const users = [...this.awareness.getStates().values()]
      .map((state) => state.user as Collaborator | undefined)
      .filter((user): user is Collaborator =>
        Boolean(user?.name && user?.color)
      );
    this.onCollaborators(users);
  };
}
