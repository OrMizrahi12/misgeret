export type OperationKind = 'syncing' | 'backingUp' | 'restoring' | 'migrating';
export type OperationState = 'idle' | OperationKind | 'shuttingDown';

export interface OperationLease {
  readonly operation: OperationKind;
  release(): void;
}

/**
 * Serializes operations that mutate or snapshot the database. A shutdown closes
 * the admission gate immediately, then waits for the in-flight lease to finish.
 */
export class OperationCoordinator {
  private active: { operation: OperationKind; token: symbol } | null = null;
  private shuttingDown = false;
  private idleWaiters = new Set<() => void>();
  private listeners = new Set<(state: OperationState) => void>();

  get state(): OperationState {
    if (this.shuttingDown) return 'shuttingDown';
    return this.active?.operation ?? 'idle';
  }

  get activeOperation(): OperationKind | null {
    return this.active?.operation ?? null;
  }

  tryBegin(operation: OperationKind): OperationLease | null {
    if (this.shuttingDown || this.active) return null;
    const token = Symbol(operation);
    this.active = { operation, token };
    this.emitState();
    let released = false;
    return {
      operation,
      release: () => {
        if (released) return;
        released = true;
        if (this.active?.token === token) {
          this.active = null;
          this.notifyIdle();
          this.emitState();
        }
      },
    };
  }

  /** Prevents new work and resolves after the active operation releases its lease. */
  beginShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.emitState();
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  waitForIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  subscribe(listener: (state: OperationState) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.state);
    } catch {
      // Runtime observers must never be able to break operation admission.
    }
    return () => this.listeners.delete(listener);
  }

  private notifyIdle(): void {
    if (this.active) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private emitState(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // State reporting is advisory; operation safety remains authoritative here.
      }
    }
  }
}
