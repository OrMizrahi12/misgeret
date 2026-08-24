import { describe, expect, test, vi } from 'vitest';
import { OperationCoordinator } from './operation-coordinator.js';

describe('OperationCoordinator', () => {
  test('serializes operations and makes leases idempotent', () => {
    const coordinator = new OperationCoordinator();
    const states: string[] = [];
    coordinator.subscribe((state) => states.push(state));
    const sync = coordinator.tryBegin('syncing');
    expect(sync).not.toBeNull();
    expect(coordinator.tryBegin('backingUp')).toBeNull();
    expect(coordinator.state).toBe('syncing');
    sync!.release();
    sync!.release();
    expect(coordinator.state).toBe('idle');
    expect(states).toEqual(['idle', 'syncing', 'idle']);
  });

  test('shutdown closes admission immediately and waits for active work', async () => {
    const coordinator = new OperationCoordinator();
    const operation = coordinator.tryBegin('restoring')!;
    const completed = vi.fn();
    const shutdown = coordinator.beginShutdown().then(completed);
    expect(coordinator.state).toBe('shuttingDown');
    expect(coordinator.tryBegin('syncing')).toBeNull();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    operation.release();
    await shutdown;
    expect(completed).toHaveBeenCalledOnce();
  });
});
