/** Who a port belongs to, as a PORT_RESERVED refusal names it. */
export interface PortOwner {
  target: string;
  project: string;
}

/** The ports one Operation plans. `reserve` runs `choose` alone among every port choice on this
 * Host, giving it the ports other Operations have planned but may not have recorded yet; the ports
 * `choose` returns stay reserved for this Operation until it ends. */
export interface PortReservations {
  reserve(
    owner: PortOwner,
    choose: (
      reserved: ReadonlyMap<number, PortOwner>,
    ) => Promise<Record<string, number>>,
  ): Promise<Record<string, number>>;
}

/** Host resources that Operations running side by side claim in short critical sections, before
 * the claim shows in the runtime state file. Every claim belongs to one Operation and ends with it,
 * when the state file records the result or the Operation failed. In memory only; no I/O. */
export interface HostReservations {
  ports(operationId: string): PortReservations;
  /** Records that `operationId` is creating the Preview `name` of `projectId`, so a concurrent
   * deploy counts it against the Project's Preview limit. */
  claimPreview(operationId: string, projectId: string, name: string): void;
  /** The Previews of `projectId` other Operations are creating. */
  claimedPreviews(projectId: string, exceptOperation: string): Set<string>;
  /** How many Preview claims of `projectId` have ended since this daemon started. A claim ends when its Operation does,
   * after the Operation recorded its Preview or failed; a change across a state read means the read may predate a
   * Preview whose claim is no longer counted, so the read must be made again. */
  endedPreviewClaims(projectId: string): number;
  release(operationId: string): void;
}

export function createHostReservations(): HostReservations {
  const ports = new Map<string, Map<number, PortOwner>>();
  const previews = new Map<string, { projectId: string; name: string }[]>();
  const ended = new Map<string, number>();
  // Port choices run one at a time: each sees every port the ones before it took.
  let choosing: Promise<unknown> = Promise.resolve();
  const reservedPorts = () =>
    new Map([...ports.values()].flatMap((owned) => [...owned]));
  return {
    ports(operationId) {
      return {
        reserve(owner, choose) {
          const chosen = choosing
            .catch(() => {})
            .then(async () => {
              const selected = await choose(reservedPorts());
              const owned = ports.get(operationId) ?? new Map();
              for (const port of Object.values(selected))
                owned.set(port, owner);
              ports.set(operationId, owned);
              return selected;
            });
          choosing = chosen;
          return chosen;
        },
      };
    },
    claimPreview(operationId, projectId, name) {
      previews.set(operationId, [
        ...(previews.get(operationId) ?? []),
        { projectId, name },
      ]);
    },
    claimedPreviews(projectId, exceptOperation) {
      return new Set(
        [...previews]
          .filter(([operation]) => operation !== exceptOperation)
          .flatMap(([, claims]) => claims)
          .filter((claim) => claim.projectId === projectId)
          .map((claim) => claim.name),
      );
    },
    endedPreviewClaims: (projectId) => ended.get(projectId) ?? 0,
    release(operationId) {
      ports.delete(operationId);
      for (const claim of previews.get(operationId) ?? [])
        ended.set(claim.projectId, (ended.get(claim.projectId) ?? 0) + 1);
      previews.delete(operationId);
    },
  };
}
